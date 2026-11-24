'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('../src/update-core');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' });
const sha = (s) => crypto.createHash('sha512').update(s).digest('base64');

function manifest(extra = {}) {
  return {
    app: 'claude-switcher',
    version: '1.2.0',
    files: [
      { name: 'Claude-Switcher-1.2.0-mac-arm64.zip', platform: 'darwin', arch: 'arm64', kind: 'zip', size: 10, sha512: sha('a') },
      { name: 'Claude-Switcher-1.2.0-mac-x64.zip', platform: 'darwin', arch: 'x64', kind: 'zip', size: 10, sha512: sha('b') },
      { name: 'Claude-Switcher-Setup-1.2.0.exe', platform: 'win32', arch: 'any', kind: 'nsis', size: 10, sha512: sha('c') },
    ],
    ...extra,
  };
}

test('manifeste signé : accepté', () => {
  const buf = Buffer.from(JSON.stringify(manifest()));
  const m = core.verifyManifest(buf, core.signManifest(buf, PRIV), PUB);
  assert.equal(m.version, '1.2.0');
});

test('manifeste modifié après signature : refusé', () => {
  const buf = Buffer.from(JSON.stringify(manifest()));
  const sig = core.signManifest(buf, PRIV);
  const tampered = Buffer.from(buf.toString().replace(sha('a'), sha('pirate')));
  assert.throws(() => core.verifyManifest(tampered, sig, PUB), /Signature de mise à jour incorrecte/);
});

test('signé par une autre clé, signature absente ou clé manquante : refusé', () => {
  const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const buf = Buffer.from(JSON.stringify(manifest()));
  assert.throws(() => core.verifyManifest(buf, core.signManifest(buf, other), PUB), /incorrecte/);
  assert.throws(() => core.verifyManifest(buf, '', PUB), /absente ou invalide/);
  assert.throws(() => core.verifyManifest(buf, core.signManifest(buf, PRIV), ''), /Aucune clé publique/);
});

test('contenu invalide même correctement signé : refusé', () => {
  const cases = [
    manifest({ app: 'autre' }),
    manifest({ version: '1.2' }),
    manifest({ files: [] }),
    manifest({ files: [{ name: '../../evil.zip', platform: 'darwin', arch: 'arm64', kind: 'zip', size: 1, sha512: sha('x') }] }),
    manifest({ files: [{ name: 'a.zip', platform: 'linux', arch: 'arm64', kind: 'zip', size: 1, sha512: sha('x') }] }),
    manifest({ files: [{ name: 'a.zip', platform: 'darwin', arch: 'arm64', kind: 'zip', size: 1, sha512: 'court' }] }),
  ];
  for (const m of cases) {
    const buf = Buffer.from(JSON.stringify(m));
    assert.throws(() => core.verifyManifest(buf, core.signManifest(buf, PRIV), PUB));
  }
});

test('choix du fichier selon la plateforme', () => {
  const m = manifest();
  assert.equal(core.pickFile(m, 'darwin', 'arm64').name, 'Claude-Switcher-1.2.0-mac-arm64.zip');
  assert.equal(core.pickFile(m, 'darwin', 'x64').name, 'Claude-Switcher-1.2.0-mac-x64.zip');
  assert.equal(core.pickFile(m, 'win32', 'x64').kind, 'nsis');
  assert.equal(core.pickFile(m, 'linux', 'x64'), null);
});

test('jamais de retour en arrière', () => {
  assert.equal(core.isNewer('1.2.0', '1.1.9'), true);
  assert.equal(core.isNewer('1.2.0', '1.2.0'), false);
  assert.equal(core.isNewer('1.1.0', '1.2.0'), false);
  assert.equal(core.isNewer('1.10.0', '1.9.0'), true);
});

test('adresses : GitHub en HTTPS uniquement (boucle locale en mode test)', () => {
  assert.ok(core.isAllowedUrl('https://github.com/o/r/releases/download/v1/a.zip'));
  assert.ok(core.isAllowedUrl('https://objects.githubusercontent.com/x'));
  assert.ok(!core.isAllowedUrl('http://github.com/x'));
  assert.ok(!core.isAllowedUrl('https://github.com.evil.io/x'));
  assert.ok(!core.isAllowedUrl('https://evil.io/github.com'));
  assert.ok(!core.isAllowedUrl('http://127.0.0.1:9/x'));
  assert.ok(core.isAllowedUrl('http://127.0.0.1:9/x', true));
  assert.ok(!core.isAllowedUrl('http://10.0.0.1/x', true));
});

test('dépôt GitHub : format validé', () => {
  assert.equal(core.releaseApiUrl('ata/claude-switcher'), 'https://api.github.com/repos/ata/claude-switcher/releases/latest');
  assert.throws(() => core.releaseApiUrl('pas un depot'));
  assert.throws(() => core.releaseApiUrl('a/b/../c'));
  assert.ok(!core.isValidRepo(''));
});

test('script de remplacement macOS : succès, puis échec avec retour à l’ancienne version', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-swap-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(root, 'open.log');
  fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "$1" >> "${log}"\n`, { mode: 0o755 });
  const mk = (dir, v) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'version'), v);
  };
  const cur = path.join(root, 'Apps', 'Claude Switcher.app');
  const neu = path.join(root, 'upd', 'Claude Switcher.app');
  const bak = path.join(root, 'upd', 'ancienne.app');
  mk(cur, '1.0.0');
  mk(neu, '1.1.0');
  const run = () =>
    spawnSync('/bin/sh', ['-c', core.MAC_SWAP_SCRIPT, 'x', '999999', cur, neu, bak], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(path.join(cur, 'version'), 'utf8'), '1.1.0');
  assert.ok(!fs.existsSync(bak));
  assert.equal(fs.readFileSync(log, 'utf8').trim(), cur);

  // Échec : la nouvelle version a disparu → l'ancienne est remise et relancée.
  assert.equal(run().status, 1);
  assert.equal(fs.readFileSync(path.join(cur, 'version'), 'utf8'), '1.1.0');
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2);
});

test('main.js ne dépend pas de la section « build » de package.json (retirée à l’empaquetage)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.ok(!/PKG\.build/.test(src));
});
