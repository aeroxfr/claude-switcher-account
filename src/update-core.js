'use strict';
/**
 * Mises à jour de Claude Switcher — fonctions pures (testées sans Electron).
 *
 * Modèle de sécurité (l'application n'a pas de certificat Apple/Microsoft) :
 *  - chaque version publiée sur GitHub contient latest.json (liste des fichiers,
 *    tailles, SHA-512) et latest.json.sig, signature Ed25519 de latest.json ;
 *  - la clé privée reste sur le poste qui publie ; l'application n'embarque que
 *    la clé publique (src/update-key.js) ;
 *  - un manifeste non signé, mal signé ou incohérent est refusé ; un fichier dont
 *    la taille ou le SHA-512 diffère est supprimé ; jamais de retour en arrière.
 * Un compte GitHub compromis ne suffit donc pas à pousser une fausse mise à jour.
 */
const crypto = require('node:crypto');
const { compareVersions } = require('./updates');

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const SHA512_RE = /^[A-Za-z0-9+/]{86}==$/;
const DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

function isValidRepo(repo) {
  return typeof repo === 'string' && REPO_RE.test(repo);
}

function releaseApiUrl(repo, base = 'https://api.github.com') {
  if (!isValidRepo(repo)) throw new Error(`Dépôt GitHub invalide : « ${repo} »`);
  return `${base}/repos/${repo}/releases/latest`;
}

/**
 * URL de téléchargement autorisée : HTTPS vers GitHub uniquement. En mode test
 * (allowLoopback), http://127.0.0.1 est aussi accepté — la signature reste
 * obligatoire dans tous les cas.
 */
function isAllowedUrl(u, allowLoopback = false) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (allowLoopback && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return true;
  return url.protocol === 'https:' && DOWNLOAD_HOSTS.has(url.hostname);
}

function signManifest(buf, privateKeyPem) {
  return crypto.sign(null, Buffer.from(buf), crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

/**
 * Vérifie la signature puis le contenu du manifeste. Renvoie l'objet validé ou
 * lève une erreur explicite.
 */
function verifyManifest(buf, signatureB64, publicKeyPem) {
  if (!publicKeyPem) throw new Error('Aucune clé publique de mise à jour configurée.');
  const data = Buffer.from(buf);
  const sig = Buffer.from(String(signatureB64 || '').trim(), 'base64');
  if (sig.length !== 64) throw new Error('Signature de mise à jour absente ou invalide.');
  if (!crypto.verify(null, data, crypto.createPublicKey(publicKeyPem), sig)) {
    throw new Error('Signature de mise à jour incorrecte : mise à jour refusée.');
  }
  let m;
  try {
    m = JSON.parse(data.toString('utf8'));
  } catch {
    throw new Error('Manifeste de mise à jour illisible.');
  }
  if (!m || m.app !== 'claude-switcher') throw new Error('Manifeste destiné à une autre application.');
  if (!VERSION_RE.test(m.version || '')) throw new Error('Version de mise à jour invalide.');
  if (!Array.isArray(m.files) || !m.files.length) throw new Error('Manifeste sans fichier.');
  for (const f of m.files) {
    if (!f || !FILE_RE.test(f.name || '')) throw new Error('Nom de fichier invalide dans le manifeste.');
    if (!['darwin', 'win32'].includes(f.platform)) throw new Error('Plateforme invalide dans le manifeste.');
    if (!['arm64', 'x64', 'any'].includes(f.arch)) throw new Error('Architecture invalide dans le manifeste.');
    if (!['zip', 'nsis'].includes(f.kind)) throw new Error('Type de fichier invalide dans le manifeste.');
    if (!SHA512_RE.test(f.sha512 || '')) throw new Error('Empreinte SHA-512 invalide dans le manifeste.');
    if (!Number.isSafeInteger(f.size) || f.size <= 0 || f.size > 2 * 1024 ** 3) throw new Error('Taille invalide dans le manifeste.');
  }
  return m;
}

/** Fichier de mise à jour pour cette plateforme / architecture. */
function pickFile(manifest, platform, arch) {
  const files = manifest.files.filter((f) => f.platform === platform);
  if (platform === 'darwin') {
    return files.find((f) => f.kind === 'zip' && f.arch === arch) || null;
  }
  if (platform === 'win32') {
    return files.find((f) => f.kind === 'nsis' && (f.arch === 'any' || f.arch === arch)) || null;
  }
  return null;
}

function isNewer(candidate, current) {
  return VERSION_RE.test(candidate || '') && compareVersions(candidate, current) > 0;
}

/**
 * Script de remplacement de l'application sur macOS, exécuté APRÈS la fermeture
 * de Claude Switcher : $1 PID à attendre, $2 application actuelle, $3 nouvelle
 * application, $4 copie de secours. En cas d'échec, l'ancienne version est remise
 * en place et relancée.
 */
const MAC_SWAP_SCRIPT = [
  'pid="$1"; cur="$2"; new="$3"; bak="$4"',
  'i=0',
  'while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 240 ]; do sleep 0.25; i=$((i+1)); done',
  'rm -rf "$bak"',
  'if mv "$cur" "$bak"; then',
  '  if mv "$new" "$cur"; then',
  '    rm -rf "$bak"',
  '    open "$cur"',
  '    exit 0',
  '  fi',
  '  mv "$bak" "$cur"',
  'fi',
  'open "$cur"',
  'exit 1',
].join('\n');

module.exports = {
  isValidRepo,
  releaseApiUrl,
  isAllowedUrl,
  signManifest,
  verifyManifest,
  pickFile,
  isNewer,
  MAC_SWAP_SCRIPT,
};
