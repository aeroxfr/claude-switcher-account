'use strict';
/**
 * Garde-fous pour les MISES À JOUR de Claude Desktop.
 *
 * Ce module ne fait que LIRE : il ne modifie jamais Claude.app, ne touche pas
 * au dossier de préparation des mises à jour et n'arrête jamais l'installateur.
 *
 * macOS (Squirrel.Mac) — Claude télécharge la nouvelle version dans
 *   ~/Library/Caches/com.anthropic.claudefordesktop.ShipIt/update.xxx/Claude.app
 * puis lance « ShipIt », qui attend que TOUTES les instances de Claude.app soient
 * fermées pour remplacer /Applications/Claude.app. Ce dossier est unique et
 * partagé par toutes les instances, quel que soit le profil. D'où trois règles :
 *   1. une seule instance à la fois par défaut (sinon l'installation reste
 *      bloquée et plusieurs instances se disputent ce dossier : c'est ce qui
 *      provoque « staging_gone » puis « Too many attempts to install ») ;
 *   2. ne jamais lancer Claude pendant que ShipIt remplace l'application ;
 *   3. ne jamais déplacer ni remplacer le dossier de données standard de Claude.
 *
 * Windows (Squirrel.Windows) — chaque version s'installe dans un nouveau
 * dossier %LOCALAPPDATA%\AnthropicClaude\app-x.y.z. Il faut toujours lancer le
 * lanceur AnthropicClaude\claude.exe (qui choisit la version la plus récente),
 * jamais un app-x.y.z\claude.exe : ce dossier disparaît à la mise à jour
 * suivante. La nouvelle version s'applique au redémarrage de Claude.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const MAC_BUNDLE_ID = 'com.anthropic.claudefordesktop';

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Compare deux versions « 1.2.3 » ; renvoie <0, 0 ou >0. */
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/* ------------------------------ macOS ------------------------------ */

function shipItDir(home = os.homedir()) {
  return path.join(home, 'Library', 'Caches', `${MAC_BUNDLE_ID}.ShipIt`);
}

function plistString(xml, key) {
  const m = String(xml).match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return m ? m[1] : null;
}

/** Version d'un bundle .app (Info.plist au format XML), ou null. */
function macAppVersion(appPath) {
  try {
    const raw = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
    return raw.startsWith('bplist') ? null : plistString(raw, 'CFBundleShortVersionString');
  } catch {
    return null;
  }
}

/** PID des processus ShipIt de Claude dans une sortie `ps -o pid=,ppid=,command=`. */
function parseShipItPids(psOutput) {
  const out = [];
  for (const line of String(psOutput).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+\d+\s+(.*)$/);
    if (!m) continue;
    if (/\/Squirrel\.framework\/Resources\/ShipIt(?: |$)/.test(m[2]) && m[2].includes(`${MAC_BUNDLE_ID}.ShipIt`)) {
      out.push(Number(m[1]));
    }
  }
  return out;
}

/**
 * État des mises à jour sur macOS.
 * @param {string} appPath  /Applications/Claude.app
 * @param {string} psOutput sortie de `ps -axww -o pid=,ppid=,command=`
 */
function macUpdateState(appPath, psOutput, home = os.homedir()) {
  const installedVersion = appPath ? macAppVersion(appPath) : null;
  let stagedVersion = null;
  let targetsThisApp = false;
  try {
    const req = JSON.parse(fs.readFileSync(path.join(shipItDir(home), 'ShipItState.plist'), 'utf8'));
    if (req && typeof req.updateBundleURL === 'string') {
      const staged = fileURLToPath(req.updateBundleURL);
      if (exists(staged)) stagedVersion = macAppVersion(staged);
    }
    if (req && typeof req.targetBundleURL === 'string' && appPath) {
      targetsThisApp = path.resolve(fileURLToPath(req.targetBundleURL)) === path.resolve(appPath);
    }
  } catch {
    /* aucune demande d'installation */
  }
  const shipItPids = parseShipItPids(psOutput);
  const pending =
    shipItPids.length > 0 &&
    targetsThisApp &&
    !!stagedVersion &&
    (!installedVersion || compareVersions(stagedVersion, installedVersion) > 0);
  return {
    platform: 'darwin',
    installedVersion,
    stagedVersion,
    shipItRunning: shipItPids.length > 0,
    pending,
  };
}

/* ----------------------------- Windows ----------------------------- */

/**
 * Remplace un chemin versionné (…\AnthropicClaude\app-1.2.3\claude.exe) par le
 * lanceur stable (…\AnthropicClaude\claude.exe), qui survit aux mises à jour.
 */
function normalizeWinClaudePath(p, existsFn = exists) {
  if (!p) return p;
  const m = String(p).match(/^(.*[\\/])app-[^\\/]+[\\/]claude\.exe$/i);
  if (m) {
    const stub = `${m[1]}claude.exe`;
    if (existsFn(stub)) return stub;
  }
  return p;
}

function winVersionOf(exePath) {
  const m = String(exePath || '').match(/[\\/]app-(\d+(?:\.\d+)*)[\\/][^\\/]+$/i);
  return m ? m[1] : null;
}

function winInstalledVersions(stubPath, readdir = fs.readdirSync) {
  try {
    return readdir(path.win32.dirname(stubPath))
      .map((d) => (String(d).match(/^app-(\d+(?:\.\d+)*)$/i) || [])[1])
      .filter(Boolean)
      .sort(compareVersions);
  } catch {
    return [];
  }
}

/**
 * Windows : une mise à jour est « en attente » si une instance ouverte tourne
 * sur une version plus ancienne que la plus récente installée.
 */
function winUpdateState(stubPath, instances, readdir) {
  const versions = winInstalledVersions(stubPath, readdir);
  const latest = versions[versions.length - 1] || null;
  const running = instances.map((i) => winVersionOf(i.exe)).filter(Boolean);
  const pending = !!latest && running.some((v) => compareVersions(v, latest) < 0);
  return { platform: 'win32', installedVersion: latest, stagedVersion: pending ? latest : null, shipItRunning: false, pending };
}

/** Windows (MSIX) : une instance tourne sur une version plus ancienne que le paquet installé. */
function winMsixUpdateState(installedVersion, instances) {
  const { msixVersionOf } = require('./windows');
  const running = instances.map((i) => msixVersionOf(i.exe)).filter(Boolean);
  const pending = !!installedVersion && running.some((v) => compareVersions(v, installedVersion) < 0);
  return {
    platform: 'win32',
    installedVersion: installedVersion || null,
    stagedVersion: pending ? installedVersion : null,
    shipItRunning: false,
    pending,
  };
}

module.exports = {
  MAC_BUNDLE_ID,
  compareVersions,
  shipItDir,
  plistString,
  macAppVersion,
  parseShipItPids,
  macUpdateState,
  normalizeWinClaudePath,
  winVersionOf,
  winInstalledVersions,
  winUpdateState,
  winMsixUpdateState,
};
