'use strict';
/**
 * Claude Switcher — processus principal.
 *
 * Principe : chaque compte a son propre dossier de profil. Claude Desktop
 * (l'application officielle, non modifiée) est lancé avec
 * --user-data-dir=<dossier du compte>. Le compte principal utilise le dossier
 * standard de Claude, sans option. La connexion (2FA, e-mail, Google, SSO) se
 * fait une seule fois, normalement, dans Claude ; la session reste ensuite
 * dans le profil, chiffrée par Claude.
 */
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  dialog,
  shell,
  nativeImage,
  Notification,
  nativeTheme,
  clipboard,
  net,
} = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const platform = require('./platform');
const profiles = require('./profiles');
const updates = require('./updates');
const windows = require('./windows');
const { Updater } = require('./updater');
const UPDATE_PUBLIC_KEY = require('./update-key').PUBLIC_KEY;
const PKG = require('../package.json');
const { Store, COLORS, PREFIXES } = require('./store');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const APP_NAME = 'Claude Switcher';
// Identique à build.appId de package.json (section absente de l'application empaquetée).
const BUNDLE_ID = 'local.claude-switcher';

/* ------------------------------------------------------------------ */
/* Dossiers                                                            */
/* ------------------------------------------------------------------ */

function computeDataRoot() {
  if (process.env.CLAUDE_SWITCHER_DATA_ROOT) return path.resolve(process.env.CLAUDE_SWITCHER_DATA_ROOT);
  const home = os.homedir();
  // Windows : hors d'AppData, pour éviter la virtualisation des installations MSIX.
  if (IS_WIN) return path.join(home, '.claude-switcher');
  if (IS_MAC) return path.join(home, 'Library', 'Application Support', APP_NAME);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'claude-switcher');
}

const DATA_ROOT = computeDataRoot();
const DIRS = {
  profiles: path.join(DATA_ROOT, 'profiles'),
  backups: path.join(DATA_ROOT, 'backups'),
  trash: path.join(DATA_ROOT, 'corbeille'),
  app: path.join(DATA_ROOT, 'app'),
};
app.setName(APP_NAME);
app.setPath('userData', DIRS.app);

/* ------------------------------------------------------------------ */
/* Journal                                                             */
/* ------------------------------------------------------------------ */

const LOG_FILE = path.join(DIRS.app, 'switcher.log');
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts
    .map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')}\n`;
  try {
    fs.mkdirSync(DIRS.app, { recursive: true });
    const st = fs.statSync(LOG_FILE, { throwIfNoEntry: false });
    if (st && st.size > 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    fs.appendFileSync(LOG_FILE, line, { mode: 0o600 });
  } catch {
    /* le journal ne doit jamais faire planter l'outil */
  }
}

class UserError extends Error {}

/* ------------------------------------------------------------------ */
/* Instance unique de l'outil                                          */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  const store = new Store(path.join(DATA_ROOT, 'accounts.json'), {
    recover: () => profiles.scanProfiles(DIRS.profiles),
  });

  let win = null;
  let tray = null;
  let quitting = false;
  let claudePath = null;
  let instances = [];
  let instancesSig = '';
  let updateState = null;
  let knownVersion = null;
  let updating = false;
  let shortcutFailures = [];
  const busyIds = new Set();
  let updater = null;
  let selfUpdateNotified = null;
  const lastLaunch = new Map();
  let queue = Promise.resolve();

  /* --------------------------- utilitaires --------------------------- */

  const serialize = (fn) => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  };

  function profileDir(acc) {
    return acc.kind === 'principal' ? platform.claudeDefaultUserData() : path.join(DIRS.profiles, acc.id);
  }

  function launchDir(acc) {
    return acc.kind === 'principal' ? null : profileDir(acc);
  }

  function ownerOf(inst) {
    const dir = platform.extractUserDataDir(inst.args);
    const principal = store.get('principal');
    if (!dir) return principal;
    const n = platform.normPath(dir);
    if (n === platform.normPath(profileDir(principal))) return principal;
    return store.accounts.find((a) => a.kind !== 'principal' && platform.normPath(profileDir(a)) === n) || null;
  }

  function runningMap() {
    const map = new Map();
    for (const inst of instances) {
      const o = ownerOf(inst);
      if (!o) continue;
      if (!map.has(o.id)) map.set(o.id, []);
      map.get(o.id).push(inst.pid);
    }
    return map;
  }

  function accelLabel(prefix) {
    const parts = prefix.split('+');
    if (IS_MAC) {
      const sym = { CommandOrControl: '⌘', Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧' };
      return parts.map((p) => sym[p] || p).join('');
    }
    const name = { CommandOrControl: 'Ctrl', Control: 'Ctrl', Alt: 'Alt', Shift: 'Maj' };
    return parts.map((p) => name[p] || p).join('+') + '+';
  }

  function notify(title, body) {
    try {
      if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
    } catch {
      /* ignore */
    }
  }

  function friendly(e) {
    if (e instanceof UserError) return e.message;
    log('Erreur', e);
    return `Erreur inattendue : ${e && e.message ? e.message : String(e)}`;
  }

  /* ----------------------------- état ------------------------------- */

  function buildState() {
    const running = runningMap();
    const statuses = new Map();
    for (const a of store.accounts) statuses.set(a.id, profiles.readProfileStatus(profileDir(a)));
    const byUuid = new Map();
    for (const a of store.accounts) {
      const u = statuses.get(a.id).accountUuid;
      if (!u) continue;
      if (!byUuid.has(u)) byUuid.set(u, []);
      byUuid.get(u).push(a.name);
    }
    const prefix = store.settings.shortcutPrefix;
    return {
      platform: process.platform,
      version: app.getVersion(),
      packaged: app.isPackaged,
      dataRoot: DATA_ROOT,
      claude: { path: claudePath, found: !!claudePath, custom: !!store.settings.claudePath, label: claudeLabel() },
      settings: store.settings,
      prefixes: PREFIXES.map((p) => ({ value: p, label: accelLabel(p).replace(/\+$/, '') })),
      shortcutLabel: accelLabel(prefix),
      shortcutFailures,
      colors: COLORS,
      defaultId: store.defaultId,
      loadReport: store.loadReport,
      selfUpdate: updater
        ? { ...updater.state, configured: updater.configured, autoUpdate: store.settings.autoUpdate }
        : { status: 'idle', configured: false, mode: { kind: 'off' } },
      update: updateState
        ? {
            pending: !!updateState.pending,
            version: updateState.stagedVersion,
            installedVersion: updateState.installedVersion,
            openCount: instances.length,
            updating,
          }
        : { pending: false, updating },
      accounts: store.accounts.map((a, i) => {
        const st = statuses.get(a.id);
        const dupes = st.accountUuid ? byUuid.get(st.accountUuid).filter((n) => n !== a.name) : [];
        return {
          id: a.id,
          kind: a.kind,
          name: a.name,
          email: a.email,
          color: a.color,
          createdAt: a.createdAt,
          lastOpenedAt: a.lastOpenedAt,
          isDefault: a.id === store.defaultId,
          running: running.has(a.id),
          busy: busyIds.has(a.id),
          shortcut: store.settings.shortcutsEnabled && i < 9 ? i + 1 : null,
          profileExists: st.exists,
          everSignedIn: st.everSignedIn,
          sessionExpiresAt: st.sessionExpiresAt === undefined ? 'unknown' : st.sessionExpiresAt,
          sameAccountAs: dupes,
        };
      }),
    };
  }

  function pushState() {
    if (win && !win.isDestroyed()) win.webContents.send('state', buildState());
  }

  async function refreshInstances(push = true) {
    let snap;
    try {
      snap = await platform.snapshot(claudePath);
    } catch (e) {
      log('Liste des instances impossible', e);
      snap = { instances: [], update: null };
    }
    const before = runningMap();
    instances = snap.instances;
    noteVersionChange(snap.update, before);
    updateState = snap.update;
    const sig = JSON.stringify([instances.map((i) => [i.pid, i.args]), updateState]);
    if (sig !== instancesSig && !quitting) {
      instancesSig = sig;
      updateTray();
      if (push) pushState();
    }
  }

  /**
   * Après une mise à jour, Claude peut redémarrer tout seul sur le profil
   * standard (sans --user-data-dir). On le signale pour que l'utilisateur ne
   * soit pas surpris de se retrouver sur le compte principal.
   */
  function noteVersionChange(update, runningBefore) {
    const v = update && update.installedVersion;
    if (!v) return;
    if (knownVersion && v !== knownVersion) {
      log(`Claude mis à jour : ${knownVersion} → ${v}`);
      const was = [...runningBefore.keys()].filter((id) => id !== 'principal');
      const acc = was.length === 1 ? store.get(was[0]) : null;
      notify(
        APP_NAME,
        acc
          ? `Claude a été mis à jour (${v}). S'il a redémarré sur le compte principal, rouvrez « ${acc.name} » d'un clic.`
          : `Claude a été mis à jour (${v}).`,
      );
    }
    knownVersion = v;
  }

  let pollTimer = null;
  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    if (quitting) return;
    pollTimer = setTimeout(async () => {
      if (quitting) return;
      await refreshInstances(true);
      schedulePoll(win && !win.isDestroyed() && win.isVisible() ? 3000 : 15000);
    }, delay);
  }

  /* --------------------------- actions ------------------------------ */

  async function resolveClaude() {
    claudePath = await platform.findClaude(store.settings.claudePath);
    if (!claudePath) {
      throw new UserError(
        store.settings.claudePath
          ? `Claude Desktop est introuvable à l'emplacement choisi (${store.settings.claudePath}).`
          : IS_WIN
            ? 'Claude Desktop est introuvable (ni paquet MSIX « Claude », ni installation classique). Installez-le depuis claude.ai/download, puis cliquez sur « Détection automatique » dans les réglages.'
            : 'Claude Desktop est introuvable. Indiquez son emplacement dans les réglages.',
      );
    }
    return claudePath;
  }

  /** Ferme proprement les instances des autres comptes gérés (jamais une instance inconnue). */
  async function closeOtherAccounts(keepId, warnings) {
    for (const inst of instances) {
      const owner = ownerOf(inst);
      if (!owner || owner.id === keepId) continue;
      const ok = await platform.closeInstance(inst.pid);
      if (!ok) {
        warnings.push(
          `« ${owner.name} » ne s'est pas fermé et reste ouvert en parallèle. Quittez-le pour que Claude puisse se mettre à jour.`,
        );
      }
    }
    await refreshInstances(false);
  }

  /**
   * macOS : si ShipIt est en train de remplacer Claude.app (plus aucune
   * instance ouverte), on attend qu'il ait fini avant de lancer quoi que ce
   * soit. Lancer Claude pendant ce temps ferait échouer la mise à jour.
   */
  async function waitForUpdateInstall(warnings) {
    if (!IS_MAC || !updateState || !updateState.shipItRunning || instances.length) return;
    updating = true;
    pushState();
    log('Installation d\'une mise à jour de Claude en cours : attente');
    try {
      const end = Date.now() + 180000;
      while (Date.now() < end) {
        await new Promise((r) => setTimeout(r, 1000));
        await refreshInstances(false);
        if (instances.length) break; // ShipIt a relancé Claude lui-même : terminé
        if (!updateState || !updateState.shipItRunning) break;
      }
      if (updateState && updateState.shipItRunning && !instances.length) {
        warnings.push("La mise à jour de Claude prend plus de temps que prévu ; Claude est ouvert quand même.");
      }
      // Laisse le temps au bundle remis en place d'être lisible.
      for (let i = 0; i < 20 && !platform.exists(path.join(claudePath, 'Contents', 'Info.plist')); i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      updating = false;
      pushState();
    }
  }

  function openAccount(id, opts = {}) {
    return serialize(async () => {
      const acc = store.get(id);
      if (!acc) throw new UserError('Compte introuvable.');
      busyIds.add(id);
      pushState();
      try {
        const appPath = await resolveClaude();
        const dir = launchDir(acc);
        if (dir) await profiles.ensureProfileDir(dir, acc);
        await refreshInstances(false);
        const closeOthers = opts.closeOthers ?? store.settings.closeOthersOnSwitch;
        const warnings = [];
        if (closeOthers) await closeOtherAccounts(acc.id, warnings);
        await waitForUpdateInstall(warnings);
        // ShipIt peut avoir relancé Claude après l'installation : on revérifie.
        if (closeOthers && instances.some((i) => (ownerOf(i) || {}).id !== acc.id && ownerOf(i))) {
          await closeOtherAccounts(acc.id, warnings);
        }
        const mine = instances.filter((i) => {
          const o = ownerOf(i);
          return o && o.id === acc.id;
        });
        const sinceLaunch = Date.now() - (lastLaunch.get(acc.id) || 0);
        if (mine.length) {
          // Déjà ouvert : on le ramène au premier plan, sans nouvelle instance.
          const ok = await platform.activateInstance(mine[0].pid, appPath, dir);
          if (!IS_MAC) guardDuplicates(acc, mine.map((i) => i.pid));
          if (!ok) await platform.launchClaude(appPath, dir);
        } else if (sinceLaunch < 10000) {
          // Lancement en cours (double clic, raccourci répété) : on n'en lance pas un second.
          log(`Lancement de ${acc.id} déjà en cours, ignoré`);
        } else {
          await platform.launchClaude(appPath, dir);
          lastLaunch.set(acc.id, Date.now());
        }
        store.update(acc.id, { lastOpenedAt: Date.now() });
        log(`Ouverture du compte ${acc.id}`, mine.length ? '(premier plan)' : closeOthers ? '(bascule)' : '(parallèle)');
        if (opts.fromWindow && store.settings.hideAfterOpen && win && !win.isDestroyed() && win.isVisible()) hideWindow();
        return { warnings };
      } finally {
        busyIds.delete(id);
        updateTray();
        pushState();
        setTimeout(() => refreshInstances(true), 2500);
        setTimeout(() => refreshInstances(true), 8000);
      }
    });
  }

  /**
   * « Installer la mise à jour » : ferme proprement tous les comptes ouverts,
   * laisse l'installateur officiel de Claude faire son travail, puis rouvre le
   * compte qui était ouvert (ou le compte par défaut).
   */
  function installUpdate() {
    return serialize(async () => {
      await resolveClaude();
      await refreshInstances(false);
      const open = store.accounts.filter((a) => runningMap().has(a.id));
      const reopen = open.length ? open[0] : store.get(store.defaultId);
      const warnings = [];
      await closeOtherAccounts(null, warnings);
      if (instances.length) {
        throw new UserError(
          "Une fenêtre Claude est restée ouverte (confirmation en attente, ou instance non gérée par Claude Switcher). Quittez-la, puis réessayez.",
        );
      }
      if (IS_MAC) {
        // ShipIt démarre l'installation dès la fermeture de la dernière instance.
        await new Promise((r) => setTimeout(r, 1500));
        await refreshInstances(false);
        await waitForUpdateInstall(warnings);
      }
      log('Mise à jour : comptes fermés, réouverture de', reopen ? reopen.id : '—');
      return { reopenId: reopen ? reopen.id : null, warnings };
    }).then(async (r) => {
      if (r.reopenId) {
        const o = await openAccount(r.reopenId);
        r.warnings.push(...o.warnings);
      }
      return { warnings: r.warnings };
    });
  }

  /**
   * Windows : si Claude n'a pas réutilisé l'instance existante du profil, on
   * referme proprement le doublon (deux instances sur un même profil
   * risqueraient d'abîmer ses données).
   */
  function guardDuplicates(acc, knownPids) {
    setTimeout(async () => {
      await refreshInstances(false);
      const extra = instances.filter((i) => {
        const o = ownerOf(i);
        return o && o.id === acc.id && !knownPids.includes(i.pid);
      });
      if (!extra.length) return;
      for (const i of extra) await platform.closeInstance(i.pid);
      log(`Doublon refermé pour ${acc.id}`, extra.map((i) => i.pid));
      notify(APP_NAME, `Claude avait ouvert une seconde fenêtre sur « ${acc.name} » : elle a été refermée.`);
    }, 5000);
  }

  function openWithFeedback(id) {
    openAccount(id)
      .then((r) => r.warnings.forEach((w) => notify(APP_NAME, w)))
      .catch((e) => notify(APP_NAME, friendly(e)));
  }

  function checkText(v, label, max, required) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (required && !s) throw new UserError(`${label} est obligatoire.`);
    if (s.length > max) throw new UserError(`${label} est trop long (${max} caractères maximum).`);
    return s;
  }

  function checkEmail(v) {
    const s = checkText(v, "L'adresse e-mail", 120, false);
    if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new UserError("L'adresse e-mail ne semble pas valide.");
    return s;
  }

  async function addAccount(input) {
    const name = checkText(input && input.name, 'Le nom', 60, true);
    const email = checkEmail(input && input.email);
    const color = COLORS.includes(input && input.color) ? input.color : store.nextColor();
    const acc = { id: `p-${crypto.randomBytes(4).toString('hex')}`, kind: 'profile', name, email, color, createdAt: Date.now() };
    const dir = profileDir(acc);
    await profiles.ensureProfileDir(dir, acc);
    let mcpCopied = false;
    if (input.copyMcp) {
      try {
        mcpCopied = await profiles.copyMcpConfig(platform.claudeDefaultUserData(), dir);
      } catch (e) {
        log('Copie MCP impossible', e);
      }
    }
    store.add(acc);
    registerShortcuts();
    updateTray();
    log(`Compte ajouté ${acc.id}`);
    let warnings = [];
    if (input.openNow !== false) {
      const r = await openAccount(acc.id, { closeOthers: !!input.closeOthersForLogin });
      warnings = r.warnings;
    }
    pushState();
    return { id: acc.id, mcpCopied, warnings };
  }

  async function updateAccount(id, patch) {
    const acc = store.get(id);
    if (!acc) throw new UserError('Compte introuvable.');
    const next = {};
    if (patch && 'name' in patch) next.name = checkText(patch.name, 'Le nom', 60, true);
    if (patch && 'email' in patch) next.email = checkEmail(patch.email);
    if (patch && COLORS.includes(patch.color)) next.color = patch.color;
    const updated = store.update(id, next);
    if (updated.kind !== 'principal') await profiles.writeMeta(profileDir(updated), updated);
    updateTray();
    pushState();
    return true;
  }

  async function assertClosed(acc) {
    await refreshInstances(false);
    if (runningMap().has(acc.id)) {
      throw new UserError(`Fermez d'abord Claude sur « ${acc.name} » (menu Claude › Quitter), puis réessayez.`);
    }
  }

  async function removeAccount(id) {
    const acc = store.get(id);
    if (!acc) throw new UserError('Compte introuvable.');
    if (acc.kind === 'principal') throw new UserError('Le compte principal ne peut pas être retiré.');
    await assertClosed(acc);
    const movedTo = await profiles.trashProfile(profileDir(acc), DIRS.trash, `${acc.id}-${acc.name.replace(/[^\w-]+/g, '_')}`);
    store.remove(id);
    registerShortcuts();
    updateTray();
    pushState();
    log(`Compte retiré ${id}, profil déplacé vers ${movedTo}`);
    return { movedTo };
  }

  async function backupAccount(id) {
    const acc = store.get(id);
    if (!acc) throw new UserError('Compte introuvable.');
    await assertClosed(acc);
    busyIds.add(id);
    pushState();
    try {
      const info = await profiles.backupProfile(profileDir(acc), DIRS.backups, acc);
      log(`Sauvegarde ${id} → ${info.name}`);
      return info;
    } finally {
      busyIds.delete(id);
      pushState();
    }
  }

  async function restoreAccount(id, backupName) {
    const acc = store.get(id);
    if (!acc) throw new UserError('Compte introuvable.');
    await assertClosed(acc);
    busyIds.add(id);
    pushState();
    try {
      const r = await profiles.restoreBackup(DIRS.backups, id, backupName, profileDir(acc), DIRS.trash);
      log(`Restauration ${id} ← ${backupName}`);
      return r;
    } finally {
      busyIds.delete(id);
      pushState();
    }
  }

  function createShortcut(id) {
    const acc = store.get(id);
    if (!acc) throw new UserError('Compte introuvable.');
    if (IS_WIN) {
      const safe = acc.name.replace(/[<>:"/\\|?*]+/g, '_');
      const lnk = path.join(app.getPath('desktop'), `Claude - ${safe}.lnk`);
      const args = (app.isPackaged ? '' : `"${app.getAppPath()}" `) + `--open=${acc.id}`;
      const ok = shell.writeShortcutLink(lnk, 'create', {
        target: process.execPath,
        args,
        description: `Ouvrir Claude sur le compte ${acc.name}`,
        icon: process.execPath,
        iconIndex: 0,
      });
      if (!ok) throw new UserError('Impossible de créer le raccourci sur le Bureau.');
      return { kind: 'file', path: lnk };
    }
    const cmd = `open -n -a "${APP_NAME}" --args --open=${acc.id}`;
    clipboard.writeText(cmd);
    return { kind: 'command', command: cmd };
  }

  function applyLoginItem() {
    if (!app.isPackaged) return;
    try {
      const wanted = store.settings.launchAtLogin;
      // N'écrit que si l'état diffère (évite une écriture système à chaque démarrage).
      if (app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin === wanted) return;
      app.setLoginItemSettings({ openAtLogin: wanted, args: ['--hidden'] });
    } catch (e) {
      log('Ouverture à la connexion impossible', e);
    }
  }

  async function updateSettings(patch) {
    const next = {};
    for (const k of ['closeOthersOnSwitch', 'shortcutsEnabled', 'launchAtLogin', 'openDefaultOnLaunch', 'hideAfterOpen', 'autoUpdate']) {
      if (patch && k in patch) next[k] = !!patch[k];
    }
    if (patch && PREFIXES.includes(patch.shortcutPrefix)) next.shortcutPrefix = patch.shortcutPrefix;
    if (patch && 'claudePath' in patch) {
      if (patch.claudePath === null) next.claudePath = null;
      else if (typeof patch.claudePath === 'string') {
        // Windows : on enregistre le lanceur stable, jamais un dossier app-x.y.z.
        const p = IS_WIN ? updates.normalizeWinClaudePath(patch.claudePath) : patch.claudePath;
        if (IS_WIN && windows.isMsixTarget(p)) {
          try {
            windows.aumidOf(p);
          } catch (e) {
            throw new UserError(e.message);
          }
        } else if (!platform.exists(p)) {
          throw new UserError('Cet emplacement de Claude Desktop est introuvable.');
        }
        next.claudePath = p;
      }
    }
    store.updateSettings(next);
    if ('launchAtLogin' in next) applyLoginItem();
    if ('claudePath' in next) claudePath = await platform.findClaude(store.settings.claudePath);
    registerShortcuts();
    updateTray();
    pushState();
    return true;
  }

  /** Libellé lisible de l'installation de Claude détectée. */
  function claudeLabel() {
    if (!claudePath) return null;
    if (IS_WIN && windows.isMsixTarget(claudePath)) {
      const info = platform.getMsixInfo();
      return `Claude — installateur moderne (MSIX${info && info.store ? ', Microsoft Store' : ''})${info && info.version ? `, version ${info.version}` : ''}`;
    }
    if (IS_WIN) return `Claude — installation classique (${claudePath})`;
    return claudePath;
  }

  async function browseClaude() {
    const res = await dialog.showOpenDialog(win, {
      title: 'Emplacement de Claude Desktop',
      defaultPath: IS_MAC ? '/Applications' : process.env.LOCALAPPDATA,
      properties: ['openFile'],
      filters: IS_MAC ? [{ name: 'Applications', extensions: ['app'] }] : [{ name: 'Programmes', extensions: ['exe'] }],
    });
    if (res.canceled || !res.filePaths[0]) return false;
    await updateSettings({ claudePath: res.filePaths[0] });
    return true;
  }

  /* ------------- mises à jour de Claude Switcher (GitHub) ------------ */

  function createUpdater() {
    // Serveur de test local uniquement (boucle locale) ; la signature reste exigée.
    const testApi = process.env.CLAUDE_SWITCHER_UPDATE_TEST_API;
    const testOk = !!testApi && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(testApi);
    updater = new Updater({
      repo: testOk && process.env.CLAUDE_SWITCHER_UPDATE_TEST_REPO ? process.env.CLAUDE_SWITCHER_UPDATE_TEST_REPO : PKG.updateRepository,
      publicKey: UPDATE_PUBLIC_KEY,
      currentVersion: app.getVersion(),
      workDir: DIRS.app,
      log,
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      exePath: app.getPath('exe'),
      productName: APP_NAME,
      bundleId: BUNDLE_ID,
      env: process.env,
      fetch: (url, init) => net.fetch(url, init),
      testApiBase: testOk ? testApi : null,
    });
    updater.on('change', (st) => {
      updateTray();
      pushState();
      if (st.status === 'ready' && selfUpdateNotified !== st.version) {
        selfUpdateNotified = st.version;
        notify(APP_NAME, `Claude Switcher ${st.version} est prêt : redémarrez l'outil pour l'installer (Claude n'est pas fermé).`);
        if (testOk && process.env.CLAUDE_SWITCHER_UPDATE_TEST_AUTOINSTALL === '1') installSelfUpdate().catch((e) => log(e));
      }
    });
  }

  async function checkSelfUpdate(manual = false) {
    if (!updater || (!manual && !store.settings.autoUpdate)) return updater ? updater.state : null;
    const available = await updater.check();
    if (available && updater.state.mode.kind === 'auto') await updater.download();
    return updater.state;
  }

  async function installSelfUpdate() {
    if (!updater) throw new UserError('Module de mise à jour indisponible.');
    await updater.install();
    log('Fermeture pour mise à jour de Claude Switcher');
    quitting = true;
    setTimeout(() => app.quit(), 300);
    return true;
  }

  /* ---------------------- raccourcis clavier ------------------------ */

  function registerShortcuts() {
    globalShortcut.unregisterAll();
    shortcutFailures = [];
    if (!store.settings.shortcutsEnabled) return;
    const prefix = store.settings.shortcutPrefix;
    store.accounts.slice(0, 9).forEach((a, i) => {
      const accel = `${prefix}+${i + 1}`;
      const id = a.id;
      let ok = false;
      try {
        ok = globalShortcut.register(accel, () => openWithFeedback(id));
      } catch {
        ok = false;
      }
      if (!ok) shortcutFailures.push(accelLabel(prefix) + (i + 1));
    });
    const accel0 = `${prefix}+0`;
    let ok0 = false;
    try {
      ok0 = globalShortcut.register(accel0, () => showWindow());
    } catch {
      ok0 = false;
    }
    if (!ok0) shortcutFailures.push(accelLabel(prefix) + '0');
  }

  /* ------------------------- barre de menus ------------------------- */

  function trayImage() {
    const file = IS_MAC ? 'trayTemplate.png' : 'tray.png';
    const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', file));
    if (IS_MAC) img.setTemplateImage(true);
    return img;
  }

  function updateTray() {
    if (!tray || tray.isDestroyed() || quitting) return;
    const running = runningMap();
    const prefix = store.settings.shortcutPrefix;
    const items = store.accounts.map((a, i) => ({
      label: `${a.name}${a.email ? `  —  ${a.email}` : ''}${a.id === store.defaultId ? '  ★' : ''}`,
      type: 'checkbox',
      checked: running.has(a.id),
      accelerator: store.settings.shortcutsEnabled && i < 9 ? `${prefix}+${i + 1}` : undefined,
      registerAccelerator: false,
      click: () => {
        openWithFeedback(a.id);
        setTimeout(updateTray, 100);
      },
    }));
    const menu = Menu.buildFromTemplate([
      { label: 'Ouvrir Claude sur…', enabled: false },
      ...items,
      { type: 'separator' },
      ...(updateState && updateState.pending
        ? [
            {
              label: `Installer la mise à jour de Claude (${updateState.stagedVersion})`,
              click: () =>
                installUpdate()
                  .then((r) => r.warnings.forEach((w) => notify(APP_NAME, w)))
                  .catch((e) => notify(APP_NAME, friendly(e))),
            },
            { type: 'separator' },
          ]
        : []),
      ...(updater && updater.state.status === 'ready'
        ? [
            { label: `Redémarrer pour mettre à jour Claude Switcher (${updater.state.version})`, click: () => installSelfUpdate().catch((e) => notify(APP_NAME, friendly(e))) },
            { type: 'separator' },
          ]
        : []),
      { label: 'Compte par défaut', click: () => openWithFeedback(store.defaultId) },
      { label: 'Gérer les comptes…', click: () => showWindow() },
      { type: 'separator' },
      { label: `Quitter ${APP_NAME}`, click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
    const n = running.size;
    tray.setToolTip(n ? `${APP_NAME} — ${n} compte(s) ouvert(s)` : APP_NAME);
  }

  function createTray() {
    tray = new Tray(trayImage());
    tray.setToolTip(APP_NAME);
    if (!IS_MAC) tray.on('click', () => (win && !win.isDestroyed() && win.isVisible() ? hideWindow() : showWindow()));
    updateTray();
  }

  /* ----------------------------- fenêtre ---------------------------- */

  function createWindow() {
    win = new BrowserWindow({
      width: 480,
      height: 660,
      minWidth: 400,
      minHeight: 480,
      show: false,
      title: APP_NAME,
      icon: IS_MAC ? undefined : path.join(__dirname, '..', 'assets', 'icon.png'),
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#17171a' : '#f6f6f7',
      titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('close', (e) => {
      if (!quitting) {
        e.preventDefault();
        hideWindow();
      }
    });
    win.on('show', () => {
      refreshInstances(true);
      schedulePoll(3000);
    });
    // Outil de développement uniquement : capture de la fenêtre pour les tests.
    if (!app.isPackaged && process.env.CLAUDE_SWITCHER_SCREENSHOT) {
      win.webContents.once('did-finish-load', () =>
        setTimeout(async () => {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.CLAUDE_SWITCHER_SCREENSHOT, img.toPNG());
          log('Capture de test écrite');
          if (process.env.CLAUDE_SWITCHER_EXIT_AFTER_SHOT) {
            quitting = true;
            app.quit();
          }
        }, 3000),
      );
    }
  }

  function showWindow() {
    if (!win || win.isDestroyed()) createWindow();
    if (IS_MAC && app.dock) app.dock.show().catch(() => {});
    const reveal = () => {
      win.show();
      win.focus();
      pushState();
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', reveal);
    else reveal();
  }

  function hideWindow() {
    if (win && !win.isDestroyed()) win.hide();
    if (IS_MAC && app.dock) app.dock.hide();
  }

  function buildAppMenu() {
    if (!IS_MAC) {
      Menu.setApplicationMenu(null);
      return;
    }
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { label: 'Fenêtre', submenu: [{ role: 'minimize' }, { role: 'close' }] },
      ]),
    );
  }

  /* ---------------------- arguments --open=… ------------------------ */

  function parseOpenArg(argv) {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a.startsWith('--open=')) return a.slice(7);
      if (a === '--open' && argv[i + 1]) return argv[i + 1];
    }
    return null;
  }

  function resolveTarget(x) {
    const v = String(x).trim();
    if (!v || v === 'default') return store.get(store.defaultId);
    if (/^[1-9]$/.test(v)) return store.accounts[Number(v) - 1] || null;
    const low = v.toLowerCase();
    return (
      store.get(v) ||
      store.accounts.find((a) => a.name.toLowerCase() === low) ||
      store.accounts.find((a) => a.email && a.email.toLowerCase() === low) ||
      null
    );
  }

  function handleOpenArg(x) {
    const acc = resolveTarget(x);
    if (!acc) {
      notify(APP_NAME, `Aucun compte ne correspond à « ${x} ».`);
      showWindow();
      return;
    }
    openWithFeedback(acc.id);
  }

  /* ------------------------------ IPC ------------------------------- */

  function handle(channel, fn) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!win || event.sender !== win.webContents) return { ok: false, error: 'Appel refusé.' };
      try {
        return { ok: true, data: await fn(...args) };
      } catch (e) {
        return { ok: false, error: friendly(e) };
      }
    });
  }

  handle('state:get', async () => {
    await refreshInstances(false);
    return buildState();
  });
  handle('account:open', (id) => openAccount(id, { fromWindow: true }));
  handle('account:add', (input) => addAccount(input || {}));
  handle('account:update', (id, patch) => updateAccount(id, patch));
  handle('account:remove', (id) => removeAccount(id));
  handle('account:setDefault', (id) => {
    store.setDefault(id);
    updateTray();
    pushState();
    return true;
  });
  handle('account:move', (id, delta) => {
    store.move(id, delta === -1 ? -1 : 1);
    registerShortcuts();
    updateTray();
    pushState();
    return true;
  });
  handle('account:backups', (id) => profiles.listBackups(DIRS.backups, id));
  handle('account:backup', (id) => backupAccount(id));
  handle('account:restore', (id, name) => restoreAccount(id, name));
  handle('account:reveal', async (id) => {
    const acc = store.get(id);
    if (!acc) throw new UserError('Compte introuvable.');
    const dir = profileDir(acc);
    if (!platform.exists(dir)) throw new UserError("Le profil n'a pas encore été créé : ouvrez le compte une première fois.");
    const err = await shell.openPath(dir);
    if (err) throw new UserError(err);
    return true;
  });
  handle('account:shortcut', (id) => createShortcut(id));
  handle('settings:update', (patch) => updateSettings(patch));
  handle('settings:browseClaude', () => browseClaude());
  handle('settings:detectClaude', async () => {
    await platform.detectMsix(true);
    return updateSettings({ claudePath: null });
  });
  handle('data:reveal', async (which) => {
    const dir = which === 'trash' ? DIRS.trash : which === 'backups' ? DIRS.backups : DATA_ROOT;
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new UserError(err);
    return true;
  });
  handle('update:install', () => installUpdate());
  handle('selfupdate:check', () => checkSelfUpdate(true));
  handle('selfupdate:install', () => installSelfUpdate());
  handle('selfupdate:open', async () => {
    const u = updater && updater.state.releaseUrl;
    if (!u || !u.startsWith('https://github.com/')) throw new UserError('Page de la version introuvable.');
    await shell.openExternal(u);
    return true;
  });
  handle('window:hide', () => {
    hideWindow();
    return true;
  });

  /* --------------------------- cycle de vie ------------------------- */

  app.on('second-instance', (_e, argv) => {
    const target = parseOpenArg(argv);
    if (target) handleOpenArg(target);
    else showWindow();
  });
  app.on('activate', () => showWindow());
  app.on('before-quit', () => {
    quitting = true;
    clearTimeout(pollTimer);
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {
    /* l'outil reste dans la barre de menus / zone de notification */
  });

  app.whenReady().then(async () => {
    for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    try {
      store.load();
    } catch (e) {
      log('Chargement des comptes impossible', e);
      dialog.showErrorBox(APP_NAME, `Impossible de lire la liste des comptes :\n${e.message}`);
    }
    if (store.loadReport && store.loadReport.startsWith('recovered')) {
      log(`Liste des comptes restaurée (${store.loadReport})`);
    }
    claudePath = await platform.findClaude(store.settings.claudePath);
    log(`Démarrage ${app.getVersion()} — Claude : ${claudePath || 'introuvable'} — données : ${DATA_ROOT}`);
    try {
      createUpdater();
    } catch (e) {
      // Les mises à jour de l'outil ne doivent jamais empêcher son démarrage.
      log('Module de mise à jour indisponible', e);
      updater = null;
    }
    buildAppMenu();
    createTray();
    createWindow();
    registerShortcuts();
    applyLoginItem();

    const target = parseOpenArg(process.argv);
    let hidden = process.argv.includes('--hidden');
    if (IS_MAC) {
      try {
        hidden = hidden || app.getLoginItemSettings().wasOpenedAtLogin;
      } catch {
        /* ignore */
      }
    }
    const autoOpen = !target && store.settings.openDefaultOnLaunch;
    if (target) handleOpenArg(target);
    else if (autoOpen) openWithFeedback(store.defaultId);
    if (!target && !autoOpen && !hidden) showWindow();
    else if (IS_MAC && app.dock) app.dock.hide();
    await refreshInstances(true);
    schedulePoll(15000);
    // Mises à jour de l'outil : 15 s après le démarrage, puis toutes les 6 heures.
    setTimeout(() => checkSelfUpdate(false).catch((e) => log(e)), Number(process.env.CLAUDE_SWITCHER_UPDATE_TEST_DELAY) || 15000);
    setInterval(() => checkSelfUpdate(false).catch((e) => log(e)), 6 * 3600 * 1000);
  });
}
