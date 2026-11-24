'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const u = require('../src/updates');

function fakeApp(dir, version) {
  fs.mkdirSync(path.join(dir, 'Contents'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'Contents', 'Info.plist'),
    `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
  );
}

const SHIPIT_LINE = (pid) =>
  `${pid}     1 /Applications/Claude.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt com.anthropic.claudefordesktop.ShipIt /Users/x/Library/Caches/com.anthropic.claudefordesktop.ShipIt/ShipItState.plist`;

test('compareVersions', () => {
  assert.ok(u.compareVersions('6.28899.6', '6.6395.1') > 0);
  assert.ok(u.compareVersions('1.2', '1.2.0') === 0);
  assert.ok(u.compareVersions('1.10.0', '1.9.9') > 0);
});

test('ShipIt : seul celui de Claude compte (pas celui de VS Code)', () => {
  const ps = [
    SHIPIT_LINE(42859),
    '80830     1 /Applications/Visual Studio Code.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt com.microsoft.VSCode.ShipIt /x/ShipItState.plist',
  ].join('\n');
  assert.deepEqual(u.parseShipItPids(ps), [42859]);
});

test('macOS : mise à jour préparée et ShipIt en attente → pending', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-upd-'));
  const app = path.join(home, 'Applications', 'Claude.app');
  fakeApp(app, '6.6395.1');
  const staged = path.join(u.shipItDir(home), 'update.AbC', 'Claude.app');
  fakeApp(staged, '6.28899.6');
  fs.writeFileSync(
    path.join(u.shipItDir(home), 'ShipItState.plist'),
    JSON.stringify({ updateBundleURL: pathToFileURL(staged).href + '/', targetBundleURL: pathToFileURL(app).href + '/' }),
  );
  const st = u.macUpdateState(app, SHIPIT_LINE(1), home);
  assert.equal(st.installedVersion, '6.6395.1');
  assert.equal(st.stagedVersion, '6.28899.6');
  assert.equal(st.pending, true);
  // Sans ShipIt en cours : pas d'installation en attente.
  assert.equal(u.macUpdateState(app, '', home).pending, false);
  // Dossier de préparation disparu : pas de faux positif.
  fs.rmSync(path.dirname(staged), { recursive: true });
  assert.equal(u.macUpdateState(app, SHIPIT_LINE(1), home).pending, false);
});

test('Windows : jamais de chemin versionné', () => {
  const ex = (p) => p === 'C:\\L\\AnthropicClaude\\claude.exe';
  assert.equal(u.normalizeWinClaudePath('C:\\L\\AnthropicClaude\\app-1.2.3\\claude.exe', ex), 'C:\\L\\AnthropicClaude\\claude.exe');
  assert.equal(u.normalizeWinClaudePath('C:\\L\\AnthropicClaude\\claude.exe', ex), 'C:\\L\\AnthropicClaude\\claude.exe');
  assert.equal(u.normalizeWinClaudePath('D:\\Autre\\claude.exe', ex), 'D:\\Autre\\claude.exe');
});

test('Windows : version plus récente installée qu’une instance ouverte → pending', () => {
  const readdir = () => ['app-1.2.3', 'app-1.10.0', 'packages', 'Update.exe', 'claude.exe'];
  const stub = 'C:\\L\\AnthropicClaude\\claude.exe';
  const old = [{ exe: 'C:\\L\\AnthropicClaude\\app-1.2.3\\claude.exe' }];
  const cur = [{ exe: 'C:\\L\\AnthropicClaude\\app-1.10.0\\claude.exe' }];
  assert.equal(u.winUpdateState(stub, old, readdir).pending, true);
  assert.equal(u.winUpdateState(stub, old, readdir).stagedVersion, '1.10.0');
  assert.equal(u.winUpdateState(stub, cur, readdir).pending, false);
  assert.equal(u.winUpdateState(stub, [], readdir).installedVersion, '1.10.0');
});
