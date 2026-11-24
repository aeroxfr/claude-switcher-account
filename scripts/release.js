'use strict';
/**
 * Publie une nouvelle version de Claude Switcher sur GitHub (Releases).
 *
 *   GH_TOKEN=… node scripts/release.js [--notes "Nouveautés…"] [--draft] [--skip-build] [--dry-run]
 *
 * Utilisé tel quel par GitHub Actions (.github/workflows/release.yml) : la clé
 * de signature vient alors du secret UPDATE_SIGNING_KEY et le jeton de GITHUB_TOKEN.
 *
 * Étapes :
 *  1. vérifie la version (package.json) et la clé de signature ;
 *  2. construit les paquets (macOS : .zip + .dmg arm64/x64 ; Windows : installateur + portable) ;
 *  3. écrit dist/latest.json (tailles + SHA-512) et dist/latest.json.sig (Ed25519) ;
 *  4. crée la Release « v<version> » et y dépose les fichiers.
 *
 * Le jeton GitHub (droit « Contents: read and write » sur le dépôt) est lu dans
 * GH_TOKEN ou GITHUB_TOKEN ; il n'est jamais enregistré.
 */
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../src/update-core');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? null : args[i + 1];
};

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const repo = pkg.updateRepository;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`Version invalide dans package.json : ${version}`);
if (!core.isValidRepo(repo)) fail('Renseignez "updateRepository": "propriétaire/dépôt" dans package.json.');

// Clé de signature : secret UPDATE_SIGNING_KEY (CI) ou fichier local. Elle doit
// correspondre à la clé publique embarquée dans l'application.
let privatePem = process.env.UPDATE_SIGNING_KEY || '';
if (!privatePem.trim()) {
  const keyPath = process.env.CLAUDE_SWITCHER_SIGNING_KEY || path.join(os.homedir(), '.claude-switcher-release', 'update-signing-key.pem');
  if (!fs.existsSync(keyPath)) fail(`Clé de signature introuvable : ${keyPath} (node scripts/update-keygen.js), ou secret UPDATE_SIGNING_KEY absent.`);
  privatePem = fs.readFileSync(keyPath, 'utf8');
}
const CI = process.env.GITHUB_ACTIONS === 'true';
if (CI && process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
  fail(`Le tag ${process.env.GITHUB_REF_NAME} ne correspond pas à la version de package.json (v${version}).`);
}
const embedded = require('../src/update-key').PUBLIC_KEY;
const derived = crypto.createPublicKey(privatePem).export({ type: 'spki', format: 'pem' }).trim();
if (!embedded || embedded.trim() !== derived) fail('La clé privée ne correspond pas à src/update-key.js : publication refusée.');

const names = {
  macArm: `Claude-Switcher-${version}-mac-arm64.zip`,
  macX64: `Claude-Switcher-${version}-mac-x64.zip`,
  dmgArm: `Claude-Switcher-${version}-mac-arm64.dmg`,
  dmgX64: `Claude-Switcher-${version}-mac-x64.dmg`,
  winSetup: `Claude-Switcher-Setup-${version}.exe`,
  winPortable: `Claude-Switcher-Portable-${version}.exe`,
};

if (!flag('--skip-build')) {
  const eb = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
  const run = (a) => execFileSync(eb, [...a, '--publish', 'never'], { cwd: ROOT, stdio: 'inherit' });
  fs.rmSync(DIST, { recursive: true, force: true });
  if (process.platform === 'darwin') run(['--mac', 'zip', 'dmg', '--arm64', '--x64']);
  run(['--win', 'nsis', 'portable', '--x64']);
}

const files = [];
const add = (name, platform, arch, kind) => {
  const p = path.join(DIST, name);
  if (!fs.existsSync(p)) return false;
  const buf = fs.readFileSync(p);
  files.push({ name, platform, arch, kind, size: buf.length, sha512: crypto.createHash('sha512').update(buf).digest('base64') });
  return true;
};
add(names.macArm, 'darwin', 'arm64', 'zip');
add(names.macX64, 'darwin', 'x64', 'zip');
add(names.winSetup, 'win32', 'any', 'nsis');
if (!files.length) fail('Aucun paquet trouvé dans dist/.');

const manifest = {
  app: 'claude-switcher',
  version,
  date: new Date().toISOString(),
  notes: opt('--notes') || process.env.RELEASE_NOTES || `Claude Switcher ${version}`,
  files,
};
const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(DIST, 'latest.json'), manifestBuf);
fs.writeFileSync(path.join(DIST, 'latest.json.sig'), core.signManifest(manifestBuf, privatePem));
core.verifyManifest(manifestBuf, fs.readFileSync(path.join(DIST, 'latest.json.sig'), 'utf8'), embedded);
console.log(`\n✔ Manifeste signé : ${files.map((f) => f.name).join(', ')}`);

const uploads = ['latest.json', 'latest.json.sig', ...Object.values(names)].filter((n) => fs.existsSync(path.join(DIST, n)));
if (flag('--dry-run')) {
  console.log(`(essai) Fichiers qui seraient publiés sur ${repo} v${version} :\n  ${uploads.join('\n  ')}`);
  process.exit(0);
}

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) fail('Jeton GitHub manquant : définissez GH_TOKEN pour cette commande.');
const gh = async (url, init = {}) => {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'claude-switcher-release',
      ...(init.headers || {}),
    },
  });
  if (!res.ok && res.status !== 404) fail(`GitHub ${res.status} sur ${url} : ${(await res.text()).slice(0, 300)}`);
  return res;
};

(async () => {
  const latest = await gh(`https://api.github.com/repos/${repo}/releases/latest`);
  if (latest.status === 200) {
    const tag = String((await latest.json()).tag_name || '').replace(/^v/, '');
    if (tag && !core.isNewer(version, tag)) fail(`La version ${version} n'est pas plus récente que la dernière publiée (${tag}). Augmentez "version" dans package.json.`);
  }
  const created = await gh(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: `v${version}`,
      ...(process.env.GITHUB_SHA ? { target_commitish: process.env.GITHUB_SHA } : {}),
      name: `Claude Switcher ${version}`,
      body: manifest.notes,
      draft: flag('--draft'),
    }),
  });
  if (created.status !== 201) fail(`Création de la Release impossible (${created.status}) : une Release v${version} existe peut-être déjà.`);
  const rel = await created.json();
  for (const name of uploads) {
    const buf = fs.readFileSync(path.join(DIST, name));
    process.stdout.write(`↑ ${name} (${Math.round(buf.length / 1e6)} Mo)… `);
    await gh(`https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) },
      body: buf,
    });
    console.log('ok');
  }
  console.log(`\n✔ Publié : ${rel.html_url}${flag('--draft') ? ' (brouillon : publiez-le sur GitHub pour le diffuser)' : ''}`);
})().catch((e) => fail(e.message));
