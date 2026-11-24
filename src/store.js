'use strict';
/**
 * Liste des comptes et réglages (accounts.json). Ne contient que des
 * métadonnées : nom, e-mail affiché, couleur, ordre, réglages. Jamais de jeton.
 *
 * Écriture atomique (fichier temporaire + renommage) avec copie .bak ; au
 * chargement, repli sur .bak puis sur les fiches présentes dans chaque profil.
 */
const fs = require('node:fs');
const path = require('node:path');

const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'];
const PREFIXES = ['CommandOrControl+Alt', 'Control+Alt', 'CommandOrControl+Shift', 'Alt+Shift'];

function defaultSettings() {
  return {
    claudePath: null,
    // Une seule instance à la fois : c'est la condition pour que Claude puisse
    // installer ses mises à jour (l'installateur attend que TOUTES ses fenêtres
    // soient fermées) et pour éviter que plusieurs instances se disputent le
    // dossier de préparation des mises à jour.
    closeOthersOnSwitch: true,
    shortcutsEnabled: true,
    shortcutPrefix: 'CommandOrControl+Alt',
    launchAtLogin: false,
    openDefaultOnLaunch: false,
    hideAfterOpen: true,
    autoUpdate: true,
  };
}

function principalAccount() {
  return {
    id: 'principal',
    kind: 'principal',
    name: 'Compte principal',
    email: '',
    color: COLORS[0],
    createdAt: Date.now(),
    lastOpenedAt: null,
  };
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isColor = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

function cleanAccount(a, i) {
  if (!a || typeof a !== 'object') return null;
  const id = str(a.id, 40);
  if (!/^(principal|p-[a-f0-9]{8})$/.test(id)) return null;
  return {
    id,
    kind: id === 'principal' ? 'principal' : 'profile',
    name: str(a.name, 60) || (id === 'principal' ? 'Compte principal' : 'Compte'),
    email: str(a.email, 120),
    color: isColor(a.color) ? a.color : COLORS[i % COLORS.length],
    createdAt: Number.isFinite(a.createdAt) ? a.createdAt : Date.now(),
    lastOpenedAt: Number.isFinite(a.lastOpenedAt) ? a.lastOpenedAt : null,
  };
}

function normalize(raw, platform = process.platform) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const accounts = [];
  (Array.isArray(data.accounts) ? data.accounts : []).forEach((a, i) => {
    const c = cleanAccount(a, i);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      accounts.push(c);
    }
  });
  if (!seen.has('principal')) accounts.unshift(principalAccount());
  const s = { ...defaultSettings(), ...(data.settings && typeof data.settings === 'object' ? data.settings : {}) };
  const settings = {
    claudePath: typeof s.claudePath === 'string' && s.claudePath ? s.claudePath : null,
    closeOthersOnSwitch: !!s.closeOthersOnSwitch,
    shortcutsEnabled: !!s.shortcutsEnabled,
    shortcutPrefix: PREFIXES.includes(s.shortcutPrefix) ? s.shortcutPrefix : PREFIXES[0],
    launchAtLogin: !!s.launchAtLogin,
    openDefaultOnLaunch: !!s.openDefaultOnLaunch,
    hideAfterOpen: s.hideAfterOpen !== false,
    autoUpdate: s.autoUpdate !== false,
  };
  const defaultId = accounts.some((a) => a.id === data.defaultId) ? data.defaultId : 'principal';
  return { version: 1, defaultId, accounts, settings };
}

class Store {
  /**
   * @param {string} file chemin de accounts.json
   * @param {{recover?: () => object[], platform?: string}} [opts]
   *   recover : fiches de profils retrouvées sur disque (si tout est illisible)
   */
  constructor(file, opts = {}) {
    this.file = file;
    this.bak = `${file}.bak`;
    this.recover = opts.recover || (() => []);
    this.platform = opts.platform || process.platform;
    this.data = normalize(null, this.platform);
    this.loadReport = null;
  }

  load() {
    const tryRead = (f) => {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch (e) {
        return e.code === 'ENOENT' ? undefined : null;
      }
    };
    const main = tryRead(this.file);
    if (main) {
      this.data = normalize(main, this.platform);
      this.loadReport = 'ok';
      return this;
    }
    if (main === undefined && !fs.existsSync(this.bak)) {
      // Premier lancement (ou fichier supprimé) : on retrouve les profils existants.
      this.data = normalize({ accounts: this.recover() }, this.platform);
      this.loadReport = this.data.accounts.length > 1 ? 'recovered-from-profiles' : 'new';
      this.save();
      return this;
    }
    const bak = tryRead(this.bak);
    if (main === null) {
      // Fichier corrompu : on le garde de côté pour analyse.
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
    }
    if (bak) {
      this.data = normalize(bak, this.platform);
      this.loadReport = 'recovered-from-backup';
    } else {
      this.data = normalize({ accounts: this.recover() }, this.platform);
      this.loadReport = 'recovered-from-profiles';
    }
    // Comptes présents sur disque mais absents de la sauvegarde.
    for (const m of this.recover()) {
      if (!this.data.accounts.some((a) => a.id === m.id)) {
        const c = cleanAccount(m, this.data.accounts.length);
        if (c) this.data.accounts.push(c);
      }
    }
    this.save();
    return this;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.data, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(this.file)) {
      try {
        fs.copyFileSync(this.file, this.bak);
      } catch {
        /* la sauvegarde .bak est un plus, pas un prérequis */
      }
    }
    fs.renameSync(tmp, this.file);
  }

  get accounts() {
    return this.data.accounts;
  }

  get settings() {
    return this.data.settings;
  }

  get defaultId() {
    return this.data.defaultId;
  }

  get(id) {
    return this.data.accounts.find((a) => a.id === id) || null;
  }

  nextColor() {
    const used = new Set(this.data.accounts.map((a) => a.color));
    return COLORS.find((c) => !used.has(c)) || COLORS[this.data.accounts.length % COLORS.length];
  }

  add(account) {
    const c = cleanAccount(account, this.data.accounts.length);
    if (!c) throw new Error('Compte invalide.');
    if (this.get(c.id)) throw new Error('Ce compte existe déjà.');
    this.data.accounts.push(c);
    this.save();
    return c;
  }

  update(id, patch) {
    const i = this.data.accounts.findIndex((a) => a.id === id);
    if (i === -1) throw new Error('Compte introuvable.');
    const c = cleanAccount({ ...this.data.accounts[i], ...patch, id }, i);
    this.data.accounts[i] = c;
    this.save();
    return c;
  }

  remove(id) {
    if (id === 'principal') throw new Error('Le compte principal ne peut pas être supprimé.');
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (this.data.defaultId === id) this.data.defaultId = 'principal';
    this.save();
  }

  move(id, delta) {
    const a = this.data.accounts;
    const i = a.findIndex((x) => x.id === id);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    this.save();
  }

  setDefault(id) {
    if (!this.get(id)) throw new Error('Compte introuvable.');
    this.data.defaultId = id;
    this.save();
  }

  updateSettings(patch) {
    this.data = normalize({ ...this.data, settings: { ...this.data.settings, ...patch } }, this.platform);
    this.save();
    return this.data.settings;
  }
}

module.exports = { Store, normalize, defaultSettings, COLORS, PREFIXES };
