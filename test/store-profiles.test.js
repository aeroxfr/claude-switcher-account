'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store, normalize } = require('../src/store');
const profiles = require('../src/profiles');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-switcher-test-'));
}

test('store : création, compte principal, ajout, ordre, défaut', () => {
  const dir = tmp();
  const s = new Store(path.join(dir, 'accounts.json'), { platform: 'darwin' }).load();
  assert.equal(s.loadReport, 'new');
  assert.equal(s.accounts.length, 1);
  assert.equal(s.accounts[0].id, 'principal');
  assert.equal(s.settings.closeOthersOnSwitch, true);
  s.add({ id: 'p-0000aaaa', name: 'Pro', email: 'pro@x.fr' });
  s.add({ id: 'p-0000bbbb', name: 'Perso' });
  s.move('p-0000bbbb', -1);
  assert.deepEqual(
    s.accounts.map((a) => a.id),
    ['principal', 'p-0000bbbb', 'p-0000aaaa'],
  );
  s.setDefault('p-0000aaaa');
  s.remove('p-0000aaaa');
  assert.equal(s.defaultId, 'principal');
  assert.throws(() => s.remove('principal'));
  const again = new Store(path.join(dir, 'accounts.json')).load();
  assert.deepEqual(
    again.accounts.map((a) => a.name),
    ['Compte principal', 'Perso'],
  );
});

test('store : réglages Windows par défaut et validation', () => {
  const n = normalize({ settings: { shortcutPrefix: 'Meta+X', closeOthersOnSwitch: 'oui' } }, 'win32');
  assert.equal(n.settings.shortcutPrefix, 'CommandOrControl+Alt');
  assert.equal(n.settings.closeOthersOnSwitch, true);
  assert.equal(normalize({}, 'win32').settings.closeOthersOnSwitch, true);
  const bad = normalize({ accounts: [{ id: '../../etc', name: 'x' }, { id: 'p-12345678', name: 'ok' }] });
  assert.deepEqual(
    bad.accounts.map((a) => a.id),
    ['principal', 'p-12345678'],
  );
});

test('store : fichier corrompu → repli sur .bak', () => {
  const dir = tmp();
  const file = path.join(dir, 'accounts.json');
  const s = new Store(file).load();
  s.add({ id: 'p-0000aaaa', name: 'A' });
  s.add({ id: 'p-0000bbbb', name: 'B' }); // .bak contient maintenant A
  fs.writeFileSync(file, '{ pas du json');
  const r = new Store(file).load();
  assert.equal(r.loadReport, 'recovered-from-backup');
  assert.ok(r.get('p-0000aaaa'));
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')));
});

test('store : tout perdu → reconstruction depuis les fiches des profils', async () => {
  const dir = tmp();
  const profilesRoot = path.join(dir, 'profiles');
  const acc = { id: 'p-0000cccc', name: 'Client', email: 'c@x.fr', color: '#10b981', createdAt: 1 };
  await profiles.ensureProfileDir(path.join(profilesRoot, acc.id), acc);
  const s = new Store(path.join(dir, 'accounts.json'), { recover: () => profiles.scanProfiles(profilesRoot) }).load();
  assert.equal(s.loadReport, 'recovered-from-profiles');
  assert.equal(s.get('p-0000cccc').email, 'c@x.fr');
});

test('profils : création en 700 et copie MCP sans écraser', async () => {
  const dir = tmp();
  const principal = path.join(dir, 'Claude');
  const prof = path.join(dir, 'profiles', 'p-0000dddd');
  fs.mkdirSync(principal);
  fs.writeFileSync(path.join(principal, 'claude_desktop_config.json'), '{"mcpServers":{}}');
  await profiles.ensureProfileDir(prof, { id: 'p-0000dddd', name: 'D', color: '#000000', createdAt: 1 });
  if (process.platform !== 'win32') assert.equal(fs.statSync(prof).mode & 0o777, 0o700);
  assert.equal(await profiles.copyMcpConfig(principal, prof), true);
  assert.equal(await profiles.copyMcpConfig(principal, prof), false);
});

test('profils : état de connexion lu sans jamais exposer de valeur', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'abc', 'oauth:tokenCache': 'SECRET' }));
  const st = profiles.readProfileStatus(dir);
  assert.equal(st.everSignedIn, true);
  assert.equal(JSON.stringify(st).includes('SECRET'), false);
  assert.equal(profiles.readProfileStatus(path.join(dir, 'absent')).exists, false);
});

test('profils : date Chrome → epoch', () => {
  // 2026-12-22T13:53:36Z
  const ms = Date.UTC(2026, 11, 22, 13, 53, 36);
  const chrome = (ms + 11644473600000) * 1000;
  assert.equal(profiles.chromeTimeToMs(chrome), ms);
  assert.equal(profiles.chromeTimeToMs(BigInt(chrome)), ms);
});

test('profils : sauvegarde sans caches, restauration sans rien supprimer', async () => {
  const root = tmp();
  const prof = path.join(root, 'profile');
  const w = (rel, txt) => {
    fs.mkdirSync(path.dirname(path.join(prof, rel)), { recursive: true });
    fs.writeFileSync(path.join(prof, rel), txt);
  };
  w('config.json', 'v1');
  w('Local Storage/leveldb/000001.log', 'ls-v1');
  w('Cache/blob', 'cache');
  w('vm_bundles/big.img', 'vm');
  w('Partitions/p1/Cache/x', 'pc');
  w('Partitions/p1/Local Storage/y', 'keep');
  w('claude-code-sessions/a/b.json', 'session');
  if (process.platform !== 'win32') fs.symlinkSync('host-123', path.join(prof, 'SingletonLock'));

  const acc = { id: 'p-0000eeee', name: 'E' };
  const info = await profiles.backupProfile(prof, path.join(root, 'backups'), acc);
  const data = path.join(root, 'backups', acc.id, info.name, 'data');
  assert.ok(fs.existsSync(path.join(data, 'config.json')));
  assert.ok(fs.existsSync(path.join(data, 'claude-code-sessions/a/b.json')));
  assert.ok(fs.existsSync(path.join(data, 'Partitions/p1/Local Storage/y')));
  assert.ok(!fs.existsSync(path.join(data, 'Cache')));
  assert.ok(!fs.existsSync(path.join(data, 'vm_bundles')));
  assert.ok(!fs.existsSync(path.join(data, 'Partitions/p1/Cache')));
  assert.ok(!fs.existsSync(path.join(data, 'SingletonLock')));

  const list = await profiles.listBackups(path.join(root, 'backups'), acc.id);
  assert.equal(list.length, 1);

  // Le profil évolue, puis on restaure.
  w('config.json', 'v2');
  w('Local Storage/leveldb/000002.log', 'ls-v2');
  const trash = path.join(root, 'trash');
  const r = await profiles.restoreBackup(path.join(root, 'backups'), acc.id, info.name, prof, trash);
  assert.equal(fs.readFileSync(path.join(prof, 'config.json'), 'utf8'), 'v1');
  // Le dossier LevelDB est remplacé en entier (pas de mélange d'états).
  assert.ok(!fs.existsSync(path.join(prof, 'Local Storage/leveldb/000002.log')));
  // Les éléments non sauvegardés sont conservés.
  assert.ok(fs.existsSync(path.join(prof, 'vm_bundles/big.img')));
  // L'état remplacé est dans la corbeille.
  assert.equal(fs.readFileSync(path.join(r.movedAsideTo, 'config.json'), 'utf8'), 'v2');
  await assert.rejects(profiles.restoreBackup(path.join(root, 'backups'), acc.id, '../evil', prof, trash));
});

test('profils : mise à la corbeille', async () => {
  const root = tmp();
  const prof = path.join(root, 'p');
  fs.mkdirSync(prof);
  fs.writeFileSync(path.join(prof, 'f'), 'x');
  const dest = await profiles.trashProfile(prof, path.join(root, 'trash'), 'p-x');
  assert.ok(!fs.existsSync(prof));
  assert.equal(fs.readFileSync(path.join(dest, 'f'), 'utf8'), 'x');
});
