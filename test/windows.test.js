'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('../src/windows');
const p = require('../src/platform');
const u = require('../src/updates');

const LOC = 'C:\\Program Files\\WindowsApps\\Claude_1.0.6543.0_x64__pzs8sxrjxfjjc';

test('MSIX : analyse de Get-AppxPackage', () => {
  const info = w.parseMsixInfo(
    JSON.stringify({ family: 'Claude_pzs8sxrjxfjjc', name: 'Claude', version: '1.0.6543.0', installLocation: LOC, appId: 'Claude', executable: 'app\\claude.exe' }),
  );
  assert.equal(info.aumid, 'Claude_pzs8sxrjxfjjc!Claude');
  assert.equal(info.exe, `${LOC}\\app\\claude.exe`);
  assert.equal(info.store, false);
  const store = w.parseMsixInfo(JSON.stringify({ family: 'AnthropicPBC.Claude_fnn82j28hfe8t', appId: '' }));
  assert.equal(store.aumid, 'AnthropicPBC.Claude_fnn82j28hfe8t!Claude');
  assert.equal(store.store, true);
  assert.equal(w.parseMsixInfo(''), null);
  assert.equal(w.parseMsixInfo('pas du json'), null);
  assert.equal(w.parseMsixInfo(JSON.stringify({ family: 'x"; rm -rf' })), null);
});

test('MSIX : cible shell:AppsFolder et validation de l’identifiant', () => {
  const t = w.msixTarget('Claude_pzs8sxrjxfjjc!Claude');
  assert.equal(t, 'shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude');
  assert.ok(w.isMsixTarget(t));
  assert.ok(!w.isMsixTarget('C:\\x\\claude.exe'));
  assert.equal(w.aumidOf(t), 'Claude_pzs8sxrjxfjjc!Claude');
  assert.throws(() => w.aumidOf('shell:AppsFolder\\evil!x;calc'));
  assert.throws(() => w.aumidOf('shell:AppsFolder\\Claude_pzs8sxrjxfjjc'));
});

test('Arguments Windows : chemins avec espaces correctement entourés', () => {
  assert.equal(w.quoteWinArg('--user-data-dir=C:\\Users\\Jean Dupont\\.claude-switcher\\profiles\\p-1'), '--user-data-dir="C:\\Users\\Jean Dupont\\.claude-switcher\\profiles\\p-1"');
  assert.equal(w.quoteWinArg('--user-data-dir=C:\\simple\\p-1'), '--user-data-dir=C:\\simple\\p-1');
  // Pas de barre oblique inverse finale (elle échapperait le guillemet fermant).
  assert.equal(w.quoteWinArg('--user-data-dir=C:\\a b\\'), '--user-data-dir="C:\\a b"');
  // Et la valeur relue depuis la ligne de commande est bien le dossier.
  assert.equal(p.extractUserDataDir(w.quoteWinArg('--user-data-dir=C:\\A B\\p-1')), 'C:\\A B\\p-1');
});

test('MSIX : version d’une instance d’après son chemin, mise à jour en attente', () => {
  assert.equal(w.msixVersionOf(`${LOC}\\app\\claude.exe`), '1.0.6543.0');
  assert.equal(w.msixVersionOf('C:\\Users\\x\\AppData\\Local\\AnthropicClaude\\app-1.2.3\\claude.exe'), null);
  const inst = [{ exe: `${LOC}\\app\\claude.exe` }];
  assert.equal(u.winMsixUpdateState('1.0.7000.0', inst).pending, true);
  assert.equal(u.winMsixUpdateState('1.0.6543.0', inst).pending, false);
  assert.equal(u.winMsixUpdateState(null, inst).pending, false);
});

test('MSIX : les processus du paquet sont bien vus comme des instances', () => {
  const json = JSON.stringify([
    { ProcessId: 50, ParentProcessId: 4, ExecutablePath: `${LOC}\\app\\claude.exe`, CommandLine: `"${LOC}\\app\\claude.exe"` },
    { ProcessId: 51, ParentProcessId: 4, ExecutablePath: `${LOC}\\app\\claude.exe`, CommandLine: `"${LOC}\\app\\claude.exe" --user-data-dir="C:\\Users\\J D\\.claude-switcher\\profiles\\p-1"` },
    { ProcessId: 52, ParentProcessId: 50, ExecutablePath: `${LOC}\\app\\claude.exe`, CommandLine: `"${LOC}\\app\\claude.exe" --type=gpu-process` },
    { ProcessId: 53, ParentProcessId: 50, ExecutablePath: 'C:\\Users\\J D\\AppData\\Roaming\\Claude\\claude-code\\2.1.0\\claude.exe', CommandLine: 'claude.exe' },
  ]);
  const inst = p.pickInstances(p.parseWinCim(json));
  assert.deepEqual(inst.map((i) => i.pid), [50, 51]);
  assert.equal(p.extractUserDataDir(inst[1].args), 'C:\\Users\\J D\\.claude-switcher\\profiles\\p-1');
});

test('Profil standard sous MSIX : le dossier du paquet prime sur %APPDATA%\\Claude', () => {
  const env = { LOCALAPPDATA: 'C:\\U\\AppData\\Local', APPDATA: 'C:\\U\\AppData\\Roaming' };
  const msixDir = 'C:\\U\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude';
  const both = (x) => x === msixDir || x === 'C:\\U\\AppData\\Roaming\\Claude';
  assert.equal(p.claudeDefaultUserData(env, 'win32', 'C:\\U', both), msixDir);
  assert.equal(p.claudeDefaultUserData(env, 'win32', 'C:\\U', () => false), 'C:\\U\\AppData\\Roaming\\Claude');
});

test('Scripts PowerShell : structure et absence d’interpolation', () => {
  assert.ok(w.FIND_MSIX_PS.includes("Get-AppxPackage -Name 'Claude'"));
  assert.ok(w.FIND_MSIX_PS.includes("Get-AppxPackage -Name 'AnthropicPBC.Claude'"));
  assert.ok(w.FIND_MSIX_PS.includes('ConvertTo-Json -Compress'));
  // Here-string C# : ouverture en fin de ligne, fermeture en début de ligne.
  const lines = w.ACTIVATE_MSIX_PS.split('\n');
  assert.ok(lines.some((l) => l.endsWith("@'")));
  assert.ok(lines.includes("'@"));
  assert.ok(w.ACTIVATE_MSIX_PS.includes('$env:CS_AUMID') && w.ACTIVATE_MSIX_PS.includes('$env:CS_ARGS'));
  // Encodage -EncodedCommand : UTF-16LE base64 réversible.
  const b64 = Buffer.from(w.ACTIVATE_MSIX_PS, 'utf16le').toString('base64');
  assert.equal(Buffer.from(b64, 'base64').toString('utf16le'), w.ACTIVATE_MSIX_PS);
  assert.ok(b64.length < 30000, 'ligne de commande Windows < 32 767 caractères');
});
