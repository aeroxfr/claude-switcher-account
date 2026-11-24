'use strict';
/**
 * Faux GitHub local pour tester les mises à jour de bout en bout.
 *
 *   node dev/fake-github.js <dossier-des-paquets> <version> [port]
 *
 * Signe un latest.json avec la vraie clé (ou CLAUDE_SWITCHER_SIGNING_KEY) et sert
 * /repos/test/claude-switcher/releases/latest + les fichiers, sur 127.0.0.1.
 * À utiliser avec un Claude Switcher lancé avec :
 *   CLAUDE_SWITCHER_UPDATE_TEST_API=http://127.0.0.1:<port>
 *   CLAUDE_SWITCHER_UPDATE_TEST_REPO=test/claude-switcher
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const core = require('../src/update-core');

const [dir, version, portArg] = process.argv.slice(2);
if (!dir || !version) {
  console.error('Usage : node dev/fake-github.js <dossier> <version> [port]');
  process.exit(1);
}
const port = Number(portArg) || 8790;
const keyPath = process.env.CLAUDE_SWITCHER_SIGNING_KEY || path.join(os.homedir(), '.claude-switcher-release', 'update-signing-key.pem');
const files = [];
for (const name of fs.readdirSync(dir)) {
  const m = name.match(/-mac-(arm64|x64)\.zip$/);
  const w = /^Claude-Switcher-Setup-.*\.exe$/.test(name);
  if (!m && !w) continue;
  const buf = fs.readFileSync(path.join(dir, name));
  files.push({
    name,
    platform: m ? 'darwin' : 'win32',
    arch: m ? m[1] : 'any',
    kind: m ? 'zip' : 'nsis',
    size: buf.length,
    sha512: crypto.createHash('sha512').update(buf).digest('base64'),
  });
}
const manifest = Buffer.from(JSON.stringify({ app: 'claude-switcher', version, date: new Date().toISOString(), notes: 'Test local', files }, null, 2));
const sig = core.signManifest(manifest, fs.readFileSync(keyPath, 'utf8'));
const base = `http://127.0.0.1:${port}`;
const assets = [
  { name: 'latest.json', browser_download_url: `${base}/dl/latest.json` },
  { name: 'latest.json.sig', browser_download_url: `${base}/dl/latest.json.sig` },
  ...files.map((f) => ({ name: f.name, browser_download_url: `${base}/dl/${encodeURIComponent(f.name)}` })),
];

http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    console.log(req.method, url);
    if (url === '/repos/test/claude-switcher/releases/latest') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ tag_name: `v${version}`, html_url: `https://github.com/test/claude-switcher/releases/tag/v${version}`, assets }));
    }
    if (url === '/dl/latest.json') return res.end(manifest);
    if (url === '/dl/latest.json.sig') return res.end(sig);
    const f = files.find((x) => `/dl/${x.name}` === url);
    if (f) {
      res.setHeader('Content-Length', f.size);
      return fs.createReadStream(path.join(dir, f.name)).pipe(res);
    }
    res.statusCode = 404;
    return res.end('introuvable');
  })
  .listen(port, '127.0.0.1', () => console.log(`Faux GitHub sur ${base} — version ${version}, fichiers : ${files.map((f) => f.name).join(', ')}`));
