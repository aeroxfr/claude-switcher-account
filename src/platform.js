'use strict';
/**
 * Tout ce qui dépend du système : trouver Claude Desktop, le lancer sur un
 * profil, lister les instances ouvertes et les fermer proprement.
 *
 * Les fonctions d'analyse (parse*, extractUserDataDir, pickInstances) sont
 * pures et testées dans test/platform.test.js.
 */
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const updates = require('./updates');
const win = require('./windows');

const PLATFORM = process.platform;
const MAC_BUNDLE_ID = 'com.anthropic.claudefordesktop';

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: 20000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      },
    );
  });
}

/**
 * Exécute un script PowerShell (Windows PowerShell 5.1) transmis encodé
 * (-EncodedCommand) : aucun souci de guillemets, sortie forcée en UTF-8.
 */
function runPowerShell(script, opts = {}) {
  const full = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${script}`;
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  return execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    opts,
  );
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Emplacements                                                        */
/* ------------------------------------------------------------------ */

/** Emplacements habituels de Claude Desktop, par ordre de préférence. */
function claudeCandidates(env = process.env, platform = PLATFORM, home = os.homedir()) {
  if (platform === 'darwin') {
    return ['/Applications/Claude.app', path.posix.join(home, 'Applications', 'Claude.app')];
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    const pf = env.ProgramFiles || 'C:\\Program Files';
    return [
      // Installateur standard (Squirrel) : lanceur qui transmet les arguments
      // à la version la plus récente (app-x.y.z\claude.exe).
      path.win32.join(local, 'AnthropicClaude', 'claude.exe'),
      path.win32.join(local, 'Programs', 'Claude', 'Claude.exe'),
      path.win32.join(pf, 'Claude', 'Claude.exe'),
    ];
  }
  return ['/usr/bin/claude-desktop', '/opt/Claude/claude'];
}

/**
 * Renvoie le chemin de Claude Desktop (.app sur macOS, .exe sur Windows),
 * ou null s'il est introuvable. Un chemin choisi par l'utilisateur prime.
 */
async function findClaude(customPath) {
  if (customPath) {
    if (PLATFORM === 'win32' && win.isMsixTarget(customPath)) {
      await detectMsix();
      return customPath;
    }
    // Windows : jamais de chemin versionné (app-x.y.z), il disparaît à la mise à jour.
    const p = PLATFORM === 'win32' ? updates.normalizeWinClaudePath(customPath) : customPath;
    return exists(p) ? p : null;
  }
  if (PLATFORM === 'win32') {
    // L'installateur moderne (MSIX) prime : quand les deux coexistent, l'ancien
    // lanceur renvoie vers le paquet MSIX.
    const info = await detectMsix();
    if (info) return win.msixTarget(info.aumid);
  }
  for (const c of claudeCandidates()) if (exists(c)) return c;
  if (PLATFORM === 'darwin') {
    try {
      const { stdout } = await execFileP('mdfind', [`kMDItemCFBundleIdentifier == '${MAC_BUNDLE_ID}'`]);
      const hit = stdout
        .split('\n')
        .map((s) => s.trim())
        .find((s) => s.endsWith('.app') && exists(s));
      if (hit) return hit;
    } catch {
      /* Spotlight indisponible : on s'en tient aux emplacements connus */
    }
  }
  return null;
}

/* --------------------------- Windows MSIX --------------------------- */

let msixCache = { at: 0, info: null };

/** Paquet MSIX de Claude installé (mis en cache 2 minutes), ou null. */
async function detectMsix(force = false) {
  if (PLATFORM !== 'win32') return null;
  if (!force && Date.now() - msixCache.at < 120000) return msixCache.info;
  let info = null;
  try {
    const { stdout } = await runPowerShell(win.FIND_MSIX_PS);
    info = win.parseMsixInfo(stdout);
  } catch {
    info = null;
  }
  msixCache = { at: Date.now(), info };
  return info;
}

function getMsixInfo() {
  return msixCache.info;
}

/**
 * Dossier de données standard de Claude Desktop (celui du « compte principal »).
 * Windows + MSIX : AppData est virtualisé ; Claude utilise le dossier du paquet
 * (LocalCache\Roaming\Claude) dès qu'il existe, sinon %APPDATA%\Claude.
 */
function claudeDefaultUserData(env = process.env, platform = PLATFORM, home = os.homedir(), existsFn = exists) {
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'Claude');
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    const families = [...new Set([...(msixCache.info ? [msixCache.info.family] : []), ...win.KNOWN_FAMILIES])];
    for (const p of win.msixUserDataCandidates(local, families)) if (existsFn(p)) return p;
    return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'Claude');
  }
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'Claude');
}

/** Normalise un chemin pour comparer deux dossiers de profil. */
function normPath(p, platform = PLATFORM) {
  if (!p) return '';
  const lib = platform === 'win32' ? path.win32 : path.posix;
  let out = lib.resolve(p.replace(/^"|"$/g, ''));
  out = out.replace(/[\\/]+$/, '');
  return platform === 'win32' ? out.toLowerCase() : out;
}

/* ------------------------------------------------------------------ */
/* Lancement                                                           */
/* ------------------------------------------------------------------ */

function launchArgs(userDataDir) {
  return userDataDir ? [`--user-data-dir=${userDataDir}`] : [];
}

/** Variables d'environnement propres à transmettre à Claude (Windows). */
function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(ELECTRON_|CHROME_|npm_|NODE_OPTIONS$|CLAUDE_USER_DATA_DIR$)/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Lance une NOUVELLE instance de Claude Desktop sur un profil (null = profil
 * standard). À n'appeler que si ce profil n'est pas déjà ouvert : sur macOS,
 * Claude ne refuse pas une seconde instance sur le même dossier (c'est
 * normalement macOS qui l'en empêche, et `open -n` contourne cette protection).
 */
async function launchClaude(appPath, userDataDir) {
  const args = launchArgs(userDataDir);
  if (PLATFORM === 'darwin') {
    // -n : nouvelle instance même si Claude tourne déjà sur un autre profil.
    await execFileP('open', ['-n', '-a', appPath, ...(args.length ? ['--args', ...args] : [])]);
    return;
  }
  if (win.isMsixTarget(appPath)) {
    await activateMsix(win.aumidOf(appPath), args);
    return;
  }
  await new Promise((resolve, reject) => {
    const child = spawn(appPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: cleanEnv(),
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Windows : lance l'application MSIX avec ses arguments par l'API officielle
 * d'activation (identité de paquet conservée). Repli : exécutable du paquet.
 */
async function activateMsix(aumid, args) {
  const argString = args.map(win.quoteWinArg).join(' ');
  try {
    await runPowerShell(win.ACTIVATE_MSIX_PS, {
      env: { ...cleanEnv(), CS_AUMID: aumid, CS_ARGS: argString },
      timeout: 45000,
    });
    return;
  } catch (e) {
    const info = await detectMsix();
    if (!info || !info.exe) {
      throw new Error(`Impossible de lancer Claude (MSIX ${aumid}) : ${String((e && e.stderr) || (e && e.message) || e).trim().slice(0, 300)}`);
    }
    // Repli (ex. PowerShell en mode restreint) : exécutable du paquet.
    await new Promise((resolve, reject) => {
      const child = spawn(info.exe, args, { detached: true, stdio: 'ignore', env: cleanEnv() });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }
}

// JXA : met au premier plan l'application d'un PID donné (sans permission
// d'accessibilité), puis lui envoie « réouverture » (kAEReopenApplication) pour
// qu'elle réaffiche sa fenêtre si celle-ci avait été fermée.
const MAC_ACTIVATE_JXA = `function run(argv) {
  ObjC.import('AppKit');
  var pid = parseInt(argv[0], 10);
  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (app.isNil()) return 'absent';
  app.activateWithOptions($.NSApplicationActivateAllWindows | $.NSApplicationActivateIgnoringOtherApps);
  try {
    var target = $.NSAppleEventDescriptor.descriptorWithProcessIdentifier(pid);
    var ev = $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(0x61657674, 0x72617070, target, -1, 0);
    ev.sendEventWithOptionsTimeoutError(1, 3, $());
  } catch (e) {}
  return 'ok';
}`;

/**
 * Ramène au premier plan une instance déjà ouverte.
 *  - macOS : activation ciblée par PID (aucune nouvelle instance).
 *  - Windows : relance sur le même profil ; Claude y détient un verrou
 *    d'instance unique par dossier de données et réaffiche sa fenêtre
 *    (même réduite dans la zone de notification). main.js vérifie ensuite
 *    qu'aucun doublon n'est apparu.
 * Renvoie false si l'instance n'existe plus.
 */
async function activateInstance(pid, appPath, userDataDir) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (PLATFORM === 'darwin') {
    const { stdout } = await execFileP('osascript', ['-l', 'JavaScript', '-e', MAC_ACTIVATE_JXA, String(pid)]);
    return stdout.trim() === 'ok';
  }
  await launchClaude(appPath, userDataDir);
  return true;
}

/* ------------------------------------------------------------------ */
/* Instances ouvertes                                                  */
/* ------------------------------------------------------------------ */

/**
 * `ps -axww -o pid=,ppid=,command=` → [{pid, ppid, exe, args}] pour le binaire
 * principal de Claude.app (les « Claude Helper » sont ignorés). Une autre appli
 * dont le nom commence par « Claude » (ex. « Claude Switcher.app ») ne correspond pas.
 */
function parseMacPs(stdout, appPath) {
  const exe = appPath ? path.posix.join(appPath, 'Contents', 'MacOS', 'Claude') : null;
  const generic = /^(.*?\/Claude\.app\/Contents\/MacOS\/Claude)(?: (.*))?$/;
  const out = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const cmd = m[3];
    if (exe && (cmd === exe || cmd.startsWith(exe + ' '))) {
      out.push({ pid, ppid, exe, args: cmd.slice(exe.length).trim(), helper: false });
      continue;
    }
    const g = cmd.match(generic);
    if (g) out.push({ pid, ppid, exe: g[1], args: (g[2] || '').trim(), helper: false });
  }
  return out;
}

/** Sortie JSON de Get-CimInstance Win32_Process → [{pid, ppid, exe, args}]. */
function parseWinCim(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return [];
  let data = JSON.parse(txt);
  if (!Array.isArray(data)) data = [data];
  const out = [];
  for (const p of data) {
    if (!p || !p.CommandLine) continue;
    const exe = p.ExecutablePath || '';
    // Le binaire « claude.exe » de Claude Code (CLI) n'est pas Claude Desktop.
    if (/[\\/](claude-code|\.local[\\/]bin|npm|node_modules)[\\/]/i.test(exe)) continue;
    out.push({
      pid: Number(p.ProcessId),
      ppid: Number(p.ParentProcessId),
      exe,
      args: stripWinExe(p.CommandLine),
      helper: /\s--type=/.test(' ' + p.CommandLine),
    });
  }
  return out;
}

function stripWinExe(cmdline) {
  const s = String(cmdline).trim();
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end === -1 ? '' : s.slice(end + 1).trim();
  }
  const sp = s.search(/\s/);
  return sp === -1 ? '' : s.slice(sp + 1).trim();
}

/**
 * Garde uniquement les processus principaux : pas de --type=… (renderer, gpu…),
 * et pas lancés par un autre processus de Claude (serveurs MCP exécutés avec le
 * Node intégré, par exemple).
 */
function pickInstances(procs) {
  const pids = new Set(procs.map((p) => p.pid));
  return procs
    .filter((p) => !p.helper && !/(^|\s)--type=/.test(p.args) && !pids.has(p.ppid))
    .map((p) => ({ pid: p.pid, args: p.args, exe: p.exe }));
}

/** Extrait la valeur de --user-data-dir d'une ligne de commande (chemins avec espaces inclus). */
function extractUserDataDir(args) {
  if (!args) return null;
  let m = args.match(/"--user-data-dir=([^"]+)"/);
  if (m) return m[1];
  m = args.match(/--user-data-dir="([^"]+)"/);
  if (m) return m[1];
  m = args.match(/--user-data-dir=(.+?)(?=\s+--|\s+"?claude:\/\/|\s*$)/);
  return m ? m[1].trim() : null;
}

async function listInstances(appPath) {
  return (await snapshot(appPath)).instances;
}

/**
 * Instances ouvertes + état des mises à jour, en un seul relevé des processus.
 * @returns {Promise<{instances: object[], update: object|null}>}
 */
async function snapshot(appPath) {
  if (PLATFORM === 'darwin') {
    const { stdout } = await execFileP('ps', ['-axww', '-o', 'pid=,ppid=,command=']);
    return {
      instances: pickInstances(parseMacPs(stdout, appPath)),
      update: updates.macUpdateState(appPath, stdout),
    };
  }
  if (PLATFORM === 'win32') {
    const instances = await listWinInstances();
    let update = null;
    if (appPath && win.isMsixTarget(appPath)) {
      const info = await detectMsix();
      update = updates.winMsixUpdateState(info && info.version, instances);
    } else if (appPath) {
      update = updates.winUpdateState(appPath, instances);
    }
    return { instances, update };
  }
  return { instances: [], update: null };
}

async function listWinInstances() {
  const script =
    "$ErrorActionPreference='SilentlyContinue';" +
    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | " +
    'Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  const { stdout } = await runPowerShell(script);
  return pickInstances(parseWinCim(stdout));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function waitForExit(pid, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return !isAlive(pid);
}

/**
 * Demande à une instance de se fermer proprement (jamais de fermeture forcée,
 * pour ne rien perdre). Renvoie false si elle est toujours ouverte au bout du
 * délai (fenêtre de confirmation, réduction dans la zone de notification…).
 */
async function closeInstance(pid, timeoutMs = PLATFORM === 'win32' ? 8000 : 15000) {
  try {
    if (PLATFORM === 'win32') await execFileP('taskkill', ['/PID', String(pid)]);
    else process.kill(pid, 'SIGTERM');
  } catch {
    if (!isAlive(pid)) return true;
  }
  return waitForExit(pid, timeoutMs);
}

module.exports = {
  PLATFORM,
  claudeCandidates,
  findClaude,
  claudeDefaultUserData,
  detectMsix,
  getMsixInfo,
  activateMsix,
  normPath,
  launchArgs,
  cleanEnv,
  launchClaude,
  activateInstance,
  parseMacPs,
  parseWinCim,
  stripWinExe,
  pickInstances,
  extractUserDataDir,
  listInstances,
  snapshot,
  closeInstance,
  isAlive,
  execFileP,
  runPowerShell,
  exists,
};
