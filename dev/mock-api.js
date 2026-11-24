'use strict';
/* API simulée pour prévisualiser l'interface dans un navigateur (dev/preview.html). */
(() => {
  const listeners = [];
  const day = 86400000;
  const state = {
    platform: new URLSearchParams(location.search).get('os') || 'darwin',
    version: '1.0.0',
    packaged: false,
    dataRoot: '/Users/vous/Library/Application Support/Claude Switcher',
    claude: { path: '/Applications/Claude.app', found: true, custom: false },
    settings: {
      claudePath: null,
      closeOthersOnSwitch: true,
      shortcutsEnabled: true,
      shortcutPrefix: 'CommandOrControl+Alt',
      launchAtLogin: false,
      openDefaultOnLaunch: false,
      hideAfterOpen: true,
    },
    prefixes: [
      { value: 'CommandOrControl+Alt', label: '⌘⌥' },
      { value: 'Control+Alt', label: '⌃⌥' },
      { value: 'CommandOrControl+Shift', label: '⌘⇧' },
      { value: 'Alt+Shift', label: '⌥⇧' },
    ],
    shortcutLabel: '⌘⌥',
    shortcutFailures: [],
    colors: ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'],
    defaultId: 'p-1a2b3c4d',
    loadReport: 'ok',
    selfUpdate: { status: 'ready', version: '1.1.0', currentVersion: '1.0.0', configured: true, autoUpdate: true, repo: 'exemple/claude-switcher', mode: { kind: 'auto' }, releaseUrl: 'https://github.com/exemple/claude-switcher/releases/tag/v1.1.0', lastCheck: Date.now() - 60000 },
    update: { pending: true, version: '6.28899.6', installedVersion: '6.6395.1', openCount: 1, updating: false },
    accounts: [
      { id: 'principal', kind: 'principal', name: 'Travail', email: 'vous@exemple.com', color: '#6366f1', running: true, busy: false, isDefault: false, shortcut: 1, profileExists: true, everSignedIn: true, sessionExpiresAt: Date.now() + 27 * day, sameAccountAs: [], lastOpenedAt: Date.now() - 3600000 },
      { id: 'p-1a2b3c4d', kind: 'profile', name: 'Perso', email: 'perso@exemple.fr', color: '#10b981', running: false, busy: false, isDefault: true, shortcut: 2, profileExists: true, everSignedIn: true, sessionExpiresAt: Date.now() + 3 * day, sameAccountAs: [], lastOpenedAt: Date.now() - 2 * day },
      { id: 'p-5e6f7a8b', kind: 'profile', name: 'Client Démo', email: '', color: '#f59e0b', running: false, busy: false, isDefault: false, shortcut: 3, profileExists: false, everSignedIn: false, sessionExpiresAt: null, sameAccountAs: [], lastOpenedAt: null },
    ],
  };
  if (state.platform === 'win32') {
    state.shortcutLabel = 'Ctrl+Alt+';
    state.settings.closeOthersOnSwitch = false;
    state.dataRoot = 'C:\\Users\\vous\\.claude-switcher';
    state.claude.path = 'shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude';
    state.claude.label = 'Claude — installateur moderne (MSIX), version 1.0.6543.0';
  }
  const ok = (data) => Promise.resolve({ ok: true, data });
  const push = () => listeners.forEach((l) => l(JSON.parse(JSON.stringify(state))));
  window.api = {
    getState: () => ok(JSON.parse(JSON.stringify(state))),
    openAccount: (id) => {
      state.accounts.forEach((a) => (a.running = state.settings.closeOthersOnSwitch ? a.id === id : a.running || a.id === id));
      push();
      return ok({ warnings: [] });
    },
    addAccount: (input) => {
      if (!input.name || !input.name.trim()) return Promise.resolve({ ok: false, error: 'Le nom est obligatoire.' });
      state.accounts.push({ id: 'p-' + Math.random().toString(16).slice(2, 10), kind: 'profile', name: input.name, email: input.email, color: input.color, running: true, busy: false, isDefault: false, shortcut: state.accounts.length + 1, profileExists: true, everSignedIn: false, sessionExpiresAt: null, sameAccountAs: [], lastOpenedAt: Date.now() });
      push();
      return ok({ id: 'x', warnings: [] });
    },
    updateAccount: (id, patch) => {
      Object.assign(state.accounts.find((a) => a.id === id), patch);
      push();
      return ok(true);
    },
    removeAccount: (id) => {
      state.accounts = state.accounts.filter((a) => a.id !== id);
      push();
      return ok({});
    },
    setDefault: (id) => {
      state.defaultId = id;
      state.accounts.forEach((a) => (a.isDefault = a.id === id));
      push();
      return ok(true);
    },
    moveAccount: () => ok(true),
    listBackups: () => ok([{ name: 'x', createdAt: Date.now() - day, sizeBytes: 48234567 }]),
    backup: () => ok({ sizeBytes: 50123456 }),
    restore: () => ok({}),
    reveal: () => ok(true),
    createShortcut: () => ok({ kind: 'command', command: 'open -n -a "Claude Switcher" --args --open=p-1' }),
    updateSettings: (patch) => {
      Object.assign(state.settings, patch);
      push();
      return ok(true);
    },
    browseClaude: () => ok(false),
    detectClaude: () => ok(true),
    revealData: () => ok(true),
    hideWindow: () => ok(true),
    checkSelfUpdate: () => ok(state.selfUpdate),
    installSelfUpdate: () => ok(true),
    openSelfUpdatePage: () => ok(true),
    installUpdate: () => {
      state.update = { pending: false, updating: false };
      push();
      return ok({ warnings: [] });
    },
    onState: (cb) => listeners.push(cb),
  };
})();
