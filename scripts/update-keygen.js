'use strict';
/**
 * Génère la paire de clés Ed25519 qui signe les mises à jour de Claude Switcher.
 *   node scripts/update-keygen.js
 *
 * - Clé PRIVÉE : ~/.claude-switcher-release/update-signing-key.pem (droits 600).
 *   Ne la mettez jamais dans le dépôt. Sauvegardez-la (gestionnaire de mots de
 *   passe, coffre-fort) : sans elle, vous ne pourrez plus publier de mise à jour
 *   acceptée par les installations existantes.
 * - Clé PUBLIQUE : écrite dans src/update-key.js (embarquée dans l'application).
 *
 * Refuse d'écraser une clé existante.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const keyPath = process.env.CLAUDE_SWITCHER_SIGNING_KEY || path.join(os.homedir(), '.claude-switcher-release', 'update-signing-key.pem');
const pubFile = path.join(__dirname, '..', 'src', 'update-key.js');

if (fs.existsSync(keyPath)) {
  console.error(`Une clé existe déjà : ${keyPath}\nRien n'a été modifié.`);
  process.exit(1);
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
const pem = publicKey.export({ type: 'spki', format: 'pem' }).trim();
fs.writeFileSync(
  pubFile,
  `'use strict';
// Clé publique de vérification des mises à jour de Claude Switcher (Ed25519).
// Générée par scripts/update-keygen.js — la clé privée correspondante ne doit
// jamais se trouver dans ce dépôt.
module.exports = {
  PUBLIC_KEY: \`${pem}\`,
};
`,
);
const fp = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
console.log(`Clé privée : ${keyPath} (à sauvegarder, à ne jamais publier)`);
console.log(`Clé publique : ${pubFile}`);
console.log(`Empreinte : ${fp}`);
