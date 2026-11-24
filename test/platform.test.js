'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/platform');

const APP = '/Applications/Claude.app';
const EXE = `${APP}/Contents/MacOS/Claude`;
const PROFILE = '/Users/me/Library/Application Support/Claude Switcher/profiles/p-1a2b3c4d';

test('macOS : instances principales, profils avec espaces, sans helpers ni enfants', () => {
  const ps = [
    `  101     1 ${EXE}`,
    `  202     1 ${EXE} --user-data-dir=${PROFILE}`,
    `  203   202 ${APP}/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer --user-data-dir=${PROFILE}`,
    `  204   101 ${EXE} /Users/me/.mcp/server.js --stdio`,
    `  305     1 /Applications/Claude Switcher.app/Contents/MacOS/Claude Switcher`,
    `  306   101 /Users/me/Library/Application Support/Claude/claude-code/2.1.0/claude --print`,
    '  999     1 /usr/sbin/cfprefsd agent',
  ].join('\n');
  const procs = p.parseMacPs(ps, APP);
  assert.deepEqual(
    procs.map((x) => x.pid),
    [101, 202, 204],
  );
  const inst = p.pickInstances(procs);
  assert.deepEqual(
    inst.map((x) => x.pid),
    [101, 202],
  );
  assert.equal(p.extractUserDataDir(inst[0].args), null);
  assert.equal(p.extractUserDataDir(inst[1].args), PROFILE);
});

test('macOS : Claude installé ailleurs (détection générique)', () => {
  const other = '/Users/me/Applications/Claude.app/Contents/MacOS/Claude';
  const procs = p.parseMacPs(`  42     1 ${other} --user-data-dir=/tmp/x`, APP);
  assert.equal(procs.length, 1);
  assert.equal(p.extractUserDataDir(procs[0].args), '/tmp/x');
});

test('Windows : analyse JSON CIM, exclut helpers, Claude Code et enfants', () => {
  const json = JSON.stringify([
    {
      ProcessId: 10,
      ParentProcessId: 4,
      ExecutablePath: 'C:\\Users\\Me\\AppData\\Local\\AnthropicClaude\\app-1.2.3\\claude.exe',
      CommandLine: '"C:\\Users\\Me\\AppData\\Local\\AnthropicClaude\\app-1.2.3\\claude.exe"',
    },
    {
      ProcessId: 20,
      ParentProcessId: 4,
      ExecutablePath: 'C:\\Users\\Me\\AppData\\Local\\AnthropicClaude\\app-1.2.3\\claude.exe',
      CommandLine:
        '"C:\\Users\\Me\\AppData\\Local\\AnthropicClaude\\app-1.2.3\\claude.exe" "--user-data-dir=C:\\Users\\Jean Dupont\\.claude-switcher\\profiles\\p-1a2b3c4d"',
    },
    {
      ProcessId: 21,
      ParentProcessId: 20,
      ExecutablePath: 'C:\\Users\\Me\\AppData\\Local\\AnthropicClaude\\app-1.2.3\\claude.exe',
      CommandLine: '"C:\\...\\claude.exe" --type=renderer --user-data-dir=x',
    },
    {
      ProcessId: 22,
      ParentProcessId: 10,
      ExecutablePath: 'C:\\Users\\Me\\AppData\\Local\\AnthropicClaude\\app-1.2.3\\claude.exe',
      CommandLine: '"C:\\...\\claude.exe" C:\\mcp\\server.js',
    },
    {
      ProcessId: 30,
      ParentProcessId: 4,
      ExecutablePath: 'C:\\Users\\Me\\.local\\bin\\claude.exe',
      CommandLine: 'claude.exe --print',
    },
  ]);
  const inst = p.pickInstances(p.parseWinCim(json));
  assert.deepEqual(
    inst.map((x) => x.pid),
    [10, 20],
  );
  assert.equal(p.extractUserDataDir(inst[1].args), 'C:\\Users\\Jean Dupont\\.claude-switcher\\profiles\\p-1a2b3c4d');
  // Un seul processus : PowerShell renvoie un objet, pas un tableau.
  const single = p.parseWinCim(JSON.stringify({ ProcessId: 5, ParentProcessId: 1, ExecutablePath: 'C:\\A\\claude.exe', CommandLine: 'C:\\A\\claude.exe' }));
  assert.equal(single.length, 1);
  assert.deepEqual(p.parseWinCim(''), []);
});

test('extractUserDataDir : formes entre guillemets et lien profond', () => {
  assert.equal(p.extractUserDataDir('--user-data-dir="C:\\A B\\c"'), 'C:\\A B\\c');
  assert.equal(p.extractUserDataDir('--user-data-dir=/a b/c --foo'), '/a b/c');
  assert.equal(p.extractUserDataDir('--user-data-dir=/a b/c claude://claude.ai/new'), '/a b/c');
  assert.equal(p.extractUserDataDir(''), null);
});

test('normPath : insensible à la casse et aux séparateurs finaux sous Windows', () => {
  assert.equal(p.normPath('C:\\Users\\X\\Profil\\', 'win32'), p.normPath('c:\\users\\x\\profil', 'win32'));
  assert.equal(p.normPath('/a/b/', 'darwin'), '/a/b');
  assert.notEqual(p.normPath('/a/B', 'darwin'), p.normPath('/a/b', 'darwin'));
});

test('emplacements par défaut', () => {
  assert.equal(p.claudeDefaultUserData({}, 'darwin', '/Users/me'), '/Users/me/Library/Application Support/Claude');
  const win = p.claudeDefaultUserData({ APPDATA: 'Z:\\nope\\Roaming', LOCALAPPDATA: 'Z:\\nope\\Local' }, 'win32', 'Z:\\nope');
  assert.equal(win, 'Z:\\nope\\Roaming\\Claude');
  const cands = p.claudeCandidates({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\U');
  assert.equal(cands[0], 'C:\\L\\AnthropicClaude\\claude.exe');
});

test('launchArgs et cleanEnv', () => {
  assert.deepEqual(p.launchArgs(null), []);
  assert.deepEqual(p.launchArgs('/x y'), ['--user-data-dir=/x y']);
  const env = p.cleanEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', npm_config_x: 'y', CLAUDE_USER_DATA_DIR: '/z', HOME: '/h' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});
