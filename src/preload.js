'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  getState: () => call('state:get'),
  openAccount: (id) => call('account:open', id),
  addAccount: (input) => call('account:add', input),
  updateAccount: (id, patch) => call('account:update', id, patch),
  removeAccount: (id) => call('account:remove', id),
  setDefault: (id) => call('account:setDefault', id),
  moveAccount: (id, delta) => call('account:move', id, delta),
  listBackups: (id) => call('account:backups', id),
  backup: (id) => call('account:backup', id),
  restore: (id, name) => call('account:restore', id, name),
  reveal: (id) => call('account:reveal', id),
  createShortcut: (id) => call('account:shortcut', id),
  updateSettings: (patch) => call('settings:update', patch),
  browseClaude: () => call('settings:browseClaude'),
  detectClaude: () => call('settings:detectClaude'),
  revealData: (which) => call('data:reveal', which),
  installUpdate: () => call('update:install'),
  checkSelfUpdate: () => call('selfupdate:check'),
  installSelfUpdate: () => call('selfupdate:install'),
  openSelfUpdatePage: () => call('selfupdate:open'),
  hideWindow: () => call('window:hide'),
  onState: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },
});
