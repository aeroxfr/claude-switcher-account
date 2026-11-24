'use strict';
/**
 * Gestion des dossiers de profil : création, état de connexion (lecture seule),
 * sauvegarde / restauration et mise à la corbeille.
 *
 * Aucune fonction ici ne lit, n'affiche ni ne copie de jeton ou de cookie
 * isolément : les sessions restent dans le profil, chiffrées par Claude
 * lui-même (Trousseau macOS / DPAPI Windows).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let sqlite = null;
try {
  // Disponible dans Node ≥ 22.13 / Electron récent. Sert uniquement à lire la
  // date d'expiration de la session (jamais sa valeur).
  sqlite = require('node:sqlite');
} catch {
  sqlite = null;
}

const META_FILE = '.claude-switcher.json';

/** Dossiers régénérables, exclus des sauvegardes (caches, binaires téléchargés). */
const SKIP_TOP = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GraphiteDawnCache',
  'GPUPersistentCache',
  'ShaderCache',
  'GrShaderCache',
  'Shared Dictionary',
  'Crashpad',
  'sentry',
  'Logs',
  'logs',
  'vm_bundles',
  'claude-code',
  'claude-code-vm',
]);
const SKIP_IN_PARTITIONS = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Shared Dictionary',
]);
const SKIP_ANYWHERE = /^(SingletonLock|SingletonSocket|SingletonCookie|RunningChromeVersion)$/;

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

async function writeJsonAtomic(file, data, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await fsp.open(tmp, 'w', mode);
  try {
    await fh.writeFile(JSON.stringify(data, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

/** Crée le dossier du profil (droits 700) et y dépose une fiche de récupération. */
async function ensureProfileDir(dir, account) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fsp.chmod(dir, 0o700).catch(() => {});
  if (account) await writeMeta(dir, account);
}

async function writeMeta(dir, account) {
  const meta = {
    tool: 'claude-switcher',
    id: account.id,
    name: account.name,
    email: account.email || '',
    color: account.color,
    createdAt: account.createdAt,
  };
  await writeJsonAtomic(path.join(dir, META_FILE), meta).catch(() => {});
}

function readMeta(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8'));
    return m && m.tool === 'claude-switcher' ? m : null;
  } catch {
    return null;
  }
}

/**
 * Copie la configuration des serveurs MCP (claude_desktop_config.json) d'un
 * profil vers un autre. Ne contient aucune session ; ne remplace pas un
 * fichier déjà présent.
 */
async function copyMcpConfig(fromDir, toDir) {
  const src = path.join(fromDir, 'claude_desktop_config.json');
  const dst = path.join(toDir, 'claude_desktop_config.json');
  if (!exists(src) || exists(dst)) return false;
  await fsp.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') await fsp.chmod(dst, 0o600).catch(() => {});
  return true;
}

/* ------------------------------------------------------------------ */
/* État de connexion (lecture seule, aucune donnée sensible)           */
/* ------------------------------------------------------------------ */

function chromeTimeToMs(v) {
  const n = typeof v === 'bigint' ? Number(v / 1000n) : Math.floor(Number(v) / 1000);
  return n - 11644473600000;
}

/**
 * Date d'expiration de la session claude.ai du profil, en ms.
 *  - nombre : date d'expiration
 *  - null   : aucune session (jamais connecté ou déconnecté)
 *  - undefined : impossible à déterminer (base verrouillée par Claude ouvert…)
 * Seule la colonne expires_utc est lue : jamais la valeur du cookie.
 */
function readSessionExpiry(dir) {
  if (!sqlite) return undefined;
  const file = [path.join(dir, 'Network', 'Cookies'), path.join(dir, 'Cookies')].find(exists);
  if (!file) return null;
  let db;
  try {
    // immutable=1 : lecture sans verrou, donc possible pendant que Claude tourne
    // (Chromium garde la base en accès exclusif) et sans jamais gêner Claude.
    const url = pathToFileURL(file);
    url.search = '?immutable=1&mode=ro';
    db = new sqlite.DatabaseSync(url, { readOnly: true });
    const stmt = db.prepare(
      "SELECT MAX(expires_utc) AS e FROM cookies WHERE name = 'sessionKey' AND host_key IN ('.claude.ai', 'claude.ai')",
    );
    if (typeof stmt.setReadBigInts === 'function') stmt.setReadBigInts(true);
    const row = stmt.get();
    if (!row || !row.e) return null;
    return chromeTimeToMs(row.e);
  } catch {
    return undefined;
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
  }
}

/** État d'un profil, pour l'affichage. Ne renvoie aucune donnée sensible. */
function readProfileStatus(dir) {
  const st = { exists: exists(dir), accountUuid: null, everSignedIn: false, sessionExpiresAt: undefined };
  if (!st.exists) return st;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    if (typeof cfg.lastKnownAccountUuid === 'string' && cfg.lastKnownAccountUuid) {
      st.accountUuid = cfg.lastKnownAccountUuid;
      st.everSignedIn = true;
    }
  } catch {
    /* profil neuf */
  }
  st.sessionExpiresAt = readSessionExpiry(dir);
  return st;
}

/* ------------------------------------------------------------------ */
/* Sauvegarde / restauration                                           */
/* ------------------------------------------------------------------ */

function shouldCopy(root, src) {
  const rel = path.relative(root, src);
  if (!rel) return true;
  const parts = rel.split(path.sep);
  const base = parts[parts.length - 1];
  if (SKIP_ANYWHERE.test(base)) return false;
  if (parts.length === 1 && SKIP_TOP.has(base)) return false;
  if (parts[0] === 'Partitions' && parts.length >= 3 && SKIP_IN_PARTITIONS.has(parts[2])) return false;
  try {
    const st = fs.lstatSync(src);
    if (st.isSocket() || st.isFIFO()) return false;
  } catch {
    return false;
  }
  return true;
}

async function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
    }
  }
  return total;
}

/**
 * Copie un profil (fermé !) dans backups/<id>/<date>/data, sans les caches.
 * Renvoie la fiche de la sauvegarde.
 */
async function backupProfile(srcDir, backupsRoot, account) {
  if (!exists(srcDir)) throw new Error("Le dossier du profil n'existe pas encore.");
  const name = stamp();
  const dest = path.join(backupsRoot, account.id, name);
  await fsp.mkdir(dest, { recursive: true, mode: 0o700 });
  try {
    await fsp.cp(srcDir, path.join(dest, 'data'), {
      recursive: true,
      filter: (src) => shouldCopy(srcDir, src),
      preserveTimestamps: true,
      verbatimSymlinks: true,
      errorOnExist: false,
      force: true,
    });
  } catch (e) {
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  const info = {
    tool: 'claude-switcher',
    name,
    accountId: account.id,
    accountName: account.name,
    createdAt: Date.now(),
    source: srcDir,
    sizeBytes: await dirSize(path.join(dest, 'data')),
    excluded: [...SKIP_TOP],
  };
  await writeJsonAtomic(path.join(dest, 'backup.json'), info);
  return info;
}

async function listBackups(backupsRoot, accountId) {
  const dir = path.join(backupsRoot, accountId);
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const info = JSON.parse(await fsp.readFile(path.join(dir, n, 'backup.json'), 'utf8'));
      if (info && info.tool === 'claude-switcher' && exists(path.join(dir, n, 'data'))) out.push(info);
    } catch {
      /* sauvegarde incomplète : ignorée */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

async function moveAside(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  try {
    await fsp.rename(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    // Volumes différents : copie complète puis suppression de l'original.
    await fsp.cp(src, dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    await fsp.rm(src, { recursive: true, force: true });
  }
}

/**
 * Restaure une sauvegarde dans un profil fermé. Chaque élément remplacé est
 * d'abord déplacé dans la corbeille (rien n'est supprimé). Les éléments
 * absents de la sauvegarde (caches, VM…) sont conservés tels quels.
 */
async function restoreBackup(backupsRoot, accountId, backupName, targetDir, trashRoot) {
  if (!/^[\w.-]+$/.test(backupName)) throw new Error('Nom de sauvegarde invalide.');
  const data = path.join(backupsRoot, accountId, backupName, 'data');
  if (!exists(data)) throw new Error('Sauvegarde introuvable.');
  const aside = path.join(trashRoot, `avant-restauration-${accountId}-${stamp()}`);
  await fsp.mkdir(targetDir, { recursive: true, mode: 0o700 });
  for (const name of await fsp.readdir(data)) {
    const cur = path.join(targetDir, name);
    if (exists(cur)) await moveAside(cur, path.join(aside, name));
    await fsp.cp(path.join(data, name), cur, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }
  return { movedAsideTo: exists(aside) ? aside : null };
}

/** Déplace un profil dans la corbeille de l'outil (jamais de suppression définitive). */
async function trashProfile(dir, trashRoot, label) {
  if (!exists(dir)) return null;
  const dest = path.join(trashRoot, `${label}-${stamp()}`);
  await moveAside(dir, dest);
  return dest;
}

/** Retrouve les profils à partir de leur fiche (si accounts.json est perdu). */
function scanProfiles(profilesRoot) {
  let names = [];
  try {
    names = fs.readdirSync(profilesRoot);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const meta = readMeta(path.join(profilesRoot, n));
    if (meta && meta.id === n) out.push(meta);
  }
  return out;
}

module.exports = {
  META_FILE,
  SKIP_TOP,
  ensureProfileDir,
  writeMeta,
  readMeta,
  copyMcpConfig,
  chromeTimeToMs,
  readSessionExpiry,
  readProfileStatus,
  shouldCopy,
  backupProfile,
  listBackups,
  restoreBackup,
  trashProfile,
  scanProfiles,
  writeJsonAtomic,
  hasSqlite: () => !!sqlite,
};
