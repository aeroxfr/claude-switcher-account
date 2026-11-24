'use strict';
/**
 * Mises à jour automatiques de Claude Switcher depuis les Releases GitHub.
 * (Ne concerne PAS Claude Desktop, qui garde son propre mécanisme.)
 *
 *  - macOS : télécharge le .zip de l'architecture, le vérifie, l'extrait, contrôle
 *    l'identité et la signature du bundle, puis un petit script remplace
 *    l'application après sa fermeture et la relance (ancienne version remise en
 *    place en cas d'échec).
 *  - Windows (version installée) : télécharge l'installateur, le vérifie, le lance
 *    en mode silencieux (/S --updated --force-run), qui relance l'outil.
 *  - Version portable, application hors d'un dossier modifiable, ou mode
 *    développement : la mise à jour est signalée, avec un lien vers la page GitHub.
 */
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const core = require('./update-core');
const { macAppVersion, plistString } = require('./updates');

const execFileP = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 120000, ...opts }, (e, stdout, stderr) => (e ? reject(Object.assign(e, { stderr })) : resolve(String(stdout)))),
  );

class Updater extends EventEmitter {
  /**
   * @param {object} o
   * @param {(url: string, init?: object) => Promise<Response>} o.fetch  net.fetch d'Electron
   */
  constructor(o) {
    super();
    this.o = o;
    this.repo = o.repo || '';
    this.publicKey = o.publicKey || '';
    this.test = !!o.testApiBase; // serveur local de test (signature toujours exigée)
    this.state = {
      status: 'idle', // idle | checking | up-to-date | available | downloading | ready | error
      currentVersion: o.currentVersion,
      version: null,
      notes: '',
      progress: 0,
      error: null,
      lastCheck: null,
      releaseUrl: null,
      mode: this.computeMode(),
      repo: this.repo,
    };
    this.pending = null; // { manifest, file, asset, localPath, appPath }
  }

  get configured() {
    return core.isValidRepo(this.repo) && !!this.publicKey;
  }

  /** auto : installation intégrée ; manual : lien vers GitHub ; off : non configuré. */
  computeMode() {
    const o = this.o;
    if (!core.isValidRepo(this.repo) || !this.publicKey) return { kind: 'off', reason: 'Source de mise à jour non configurée.' };
    if (!o.isPackaged && !this.test) return { kind: 'manual', reason: 'Mode développement.' };
    if (o.platform === 'darwin') {
      const bundle = this.macBundlePath();
      if (!bundle) return { kind: 'manual', reason: 'Application introuvable.' };
      if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) {
        return { kind: 'manual', reason: 'Placez Claude Switcher dans le dossier Applications pour activer les mises à jour automatiques.' };
      }
      try {
        fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
        fs.accessSync(bundle, fs.constants.W_OK);
      } catch {
        return { kind: 'manual', reason: "Le dossier de l'application n'est pas modifiable par votre session." };
      }
      return { kind: 'auto' };
    }
    if (o.platform === 'win32') {
      if (o.env.PORTABLE_EXECUTABLE_DIR) return { kind: 'manual', reason: 'Version portable : téléchargez la nouvelle version.' };
      const dir = path.dirname(o.exePath);
      const installed = fs.existsSync(path.join(dir, `Uninstall ${o.productName}.exe`));
      return installed ? { kind: 'auto' } : { kind: 'manual', reason: 'Version non installée : téléchargez la nouvelle version.' };
    }
    return { kind: 'manual', reason: 'Plateforme sans installation automatique.' };
  }

  macBundlePath() {
    const p = path.resolve(this.o.exePath, '..', '..', '..');
    return p.endsWith('.app') ? p : null;
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.emit('change', this.state);
  }

  /** Adresse autorisée : API GitHub, fichiers GitHub en HTTPS (ou serveur local de test). */
  allowed(url) {
    if (typeof url !== 'string') return false;
    if (url.startsWith('https://api.github.com/')) return true;
    if (this.test && url.startsWith(this.o.testApiBase)) return true;
    return core.isAllowedUrl(url, this.test);
  }

  async fetchOk(url, init = {}, { allow404 = false } = {}) {
    if (!this.allowed(url)) throw new Error(`Adresse de téléchargement refusée : ${url}`);
    const res = await this.o.fetch(url, {
      ...init,
      headers: { 'User-Agent': 'Claude-Switcher-Updater', Accept: 'application/vnd.github+json', ...(init.headers || {}) },
    });
    if (res.url && !this.allowed(res.url)) throw new Error(`Redirection refusée : ${res.url}`);
    if (allow404 && res.status === 404) return res;
    if (!res.ok) throw new Error(`GitHub a répondu ${res.status} pour ${new URL(url).pathname}`);
    return res;
  }

  /** Cherche une nouvelle version. Renvoie true si une mise à jour est disponible. */
  async check() {
    if (!this.configured) {
      this.set({ status: 'idle', mode: this.computeMode() });
      return false;
    }
    if (['checking', 'downloading'].includes(this.state.status)) return false;
    if (this.state.status === 'ready') return true;
    this.set({ status: 'checking', error: null, mode: this.computeMode() });
    try {
      const api = this.test ? `${this.o.testApiBase}/repos/${this.repo}/releases/latest` : core.releaseApiUrl(this.repo);
      const relRes = await this.fetchOk(api, {}, { allow404: true });
      if (relRes.status === 404) {
        // Aucune Release publiée pour l'instant : rien à installer.
        this.set({ status: 'up-to-date', lastCheck: Date.now(), version: null });
        this.o.log('Mise à jour de Claude Switcher : aucune version publiée');
        return false;
      }
      const rel = await relRes.json();
      const assets = Array.isArray(rel.assets) ? rel.assets : [];
      const find = (name) => assets.find((a) => a && a.name === name);
      const mAsset = find('latest.json');
      const sAsset = find('latest.json.sig');
      if (!mAsset || !sAsset) throw new Error('La dernière version publiée ne contient pas de manifeste signé.');
      const manifestBuf = Buffer.from(await (await this.fetchOk(mAsset.browser_download_url, { headers: { Accept: 'application/octet-stream' } })).arrayBuffer());
      const sig = await (await this.fetchOk(sAsset.browser_download_url, { headers: { Accept: 'application/octet-stream' } })).text();
      const manifest = core.verifyManifest(manifestBuf, sig, this.publicKey);
      const releaseUrl = typeof rel.html_url === 'string' && rel.html_url.startsWith('https://github.com/') ? rel.html_url : null;
      if (!core.isNewer(manifest.version, this.o.currentVersion)) {
        this.o.log(`Mise à jour de Claude Switcher : à jour (${this.o.currentVersion}, dernière publiée ${manifest.version})`);
        this.set({ status: 'up-to-date', lastCheck: Date.now(), version: null, releaseUrl });
        return false;
      }
      const file = core.pickFile(manifest, this.o.platform, this.o.arch);
      const asset = file && find(file.name);
      this.pending = file && asset ? { manifest, file, asset } : null;
      this.o.log(`Mise à jour de Claude Switcher : version ${manifest.version} disponible`);
      this.set({
        status: 'available',
        version: manifest.version,
        notes: typeof manifest.notes === 'string' ? manifest.notes.slice(0, 2000) : '',
        lastCheck: Date.now(),
        releaseUrl,
        mode: this.pending ? this.computeMode() : { kind: 'manual', reason: 'Aucun fichier pour cette plateforme dans cette version.' },
      });
      return true;
    } catch (e) {
      this.o.log('Recherche de mise à jour impossible', e);
      this.set({ status: 'error', error: e.message, lastCheck: Date.now() });
      return false;
    }
  }

  /** Télécharge et vérifie (taille + SHA-512) le fichier de la mise à jour. */
  async download() {
    if (this.state.status !== 'available' || !this.pending || this.state.mode.kind !== 'auto') return false;
    const { file, asset } = this.pending;
    const dir = path.join(this.o.workDir, 'updates');
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const dest = path.join(dir, file.name);
    this.set({ status: 'downloading', progress: 0, error: null });
    try {
      const res = await this.fetchOk(asset.browser_download_url, { headers: { Accept: 'application/octet-stream' } });
      const hash = crypto.createHash('sha512');
      const out = fs.createWriteStream(dest, { mode: 0o600 });
      let got = 0;
      let lastEmit = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (got > file.size) throw new Error('Fichier plus gros que prévu : téléchargement interrompu.');
        hash.update(value);
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        if (Date.now() - lastEmit > 250) {
          lastEmit = Date.now();
          this.set({ progress: got / file.size });
        }
      }
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
      if (got !== file.size) throw new Error('Téléchargement incomplet.');
      if (hash.digest('base64') !== file.sha512) throw new Error('Empreinte SHA-512 différente : fichier rejeté.');
      this.pending.localPath = dest;
      if (this.o.platform === 'darwin') this.pending.appPath = await this.prepareMac(dest, dir);
      this.set({ status: 'ready', progress: 1 });
      return true;
    } catch (e) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      this.o.log('Téléchargement de la mise à jour impossible', e);
      this.set({ status: 'error', error: e.message });
      return false;
    }
  }

  /** macOS : extrait et contrôle la nouvelle application avant toute installation. */
  async prepareMac(zip, dir) {
    const out = path.join(dir, 'extrait');
    await fsp.mkdir(out, { recursive: true });
    await execFileP('/usr/bin/ditto', ['-x', '-k', zip, out]);
    const name = `${this.o.productName}.app`;
    const app = path.join(out, name);
    if (!fs.existsSync(app)) throw new Error(`L'archive ne contient pas ${name}.`);
    const plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');
    if (plistString(plist, 'CFBundleIdentifier') !== this.o.bundleId) throw new Error("L'application téléchargée n'a pas le bon identifiant.");
    if (macAppVersion(app) !== this.pending.manifest.version) throw new Error("La version de l'application téléchargée ne correspond pas.");
    await execFileP('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    await execFileP('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]).catch(() => {});
    return app;
  }

  /**
   * Lance l'installation. L'appelant doit quitter l'application juste après
   * (le script / l'installateur attend sa fermeture).
   */
  async install() {
    if (this.state.status !== 'ready' || !this.pending || !this.pending.localPath) throw new Error("Aucune mise à jour prête à installer.");
    if (this.o.platform === 'darwin') {
      const cur = this.macBundlePath();
      const bak = path.join(path.dirname(this.pending.appPath), 'ancienne-version.app');
      const child = spawn('/bin/sh', ['-c', core.MAC_SWAP_SCRIPT, 'claude-switcher-update', String(process.pid), cur, this.pending.appPath, bak], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      this.o.log(`Mise à jour ${this.state.version} : remplacement de ${cur} après fermeture`);
      return;
    }
    if (this.o.platform === 'win32') {
      const child = spawn(this.pending.localPath, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' });
      child.unref();
      this.o.log(`Mise à jour ${this.state.version} : installateur lancé`);
      return;
    }
    throw new Error('Installation automatique non prise en charge sur cette plateforme.');
  }
}

module.exports = { Updater };
