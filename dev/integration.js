'use strict';
/**
 * Test d'intégration avec le vrai Claude Desktop (macOS ou Windows) :
 * ouvre un profil de test jetable, vérifie la détection, la remise au premier
 * plan sans doublon, puis la fermeture propre. Ne touche jamais au profil
 * principal ni à une autre instance.
 *
 *   node dev/integration.js [dossier-de-test]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const platform = require('../src/platform');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'claude-switcher-it-')));

function mine(list) {
  return list.filter((i) => platform.normPath(platform.extractUserDataDir(i.args) || '') === platform.normPath(dir));
}

async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await platform.listInstances(app);
    if (pred(list)) return list;
    await sleep(500);
  }
  return platform.listInstances(app);
}

let app;
(async () => {
  app = await platform.findClaude(null);
  if (!app) throw new Error('Claude Desktop introuvable');
  console.log('Claude :', app);
  console.log('Profil de test :', dir);
  fs.mkdirSync(dir, { recursive: true });

  const before = await platform.listInstances(app);
  const others = before.filter((i) => !mine([i]).length).map((i) => i.pid);
  console.log('Autres instances (intouchées) :', others);

  await platform.launchClaude(app, dir);
  let list = await waitFor((l) => mine(l).length === 1, 20000);
  const first = mine(list);
  if (first.length !== 1) throw new Error(`instance de test non détectée (${first.length})`);
  console.log('✔ instance détectée, pid', first[0].pid);
  for (let i = 0; i < 30 && !fs.existsSync(path.join(dir, 'config.json')); i++) await sleep(500);
  if (!fs.existsSync(path.join(dir, 'config.json'))) throw new Error('le profil de test ne contient pas config.json');
  console.log('✔ Claude écrit bien dans le dossier du profil');

  const activated = await platform.activateInstance(first[0].pid, app, dir);
  if (!activated) throw new Error("l'activation de l'instance a échoué");
  await sleep(6000);
  list = await platform.listInstances(app);
  if (mine(list).length !== 1 || mine(list)[0].pid !== first[0].pid) throw new Error('la ré-ouverture a créé un doublon');
  console.log('✔ ré-ouverture : premier plan, sans doublon');

  const ok = await platform.closeInstance(first[0].pid, 20000);
  if (!ok) throw new Error('fermeture propre non aboutie');
  list = await platform.listInstances(app);
  if (mine(list).length) throw new Error('instance encore présente');
  console.log('✔ fermeture propre');

  const after = list.map((i) => i.pid);
  for (const pid of others) if (!after.includes(pid)) throw new Error(`une autre instance (${pid}) a disparu !`);
  console.log('✔ les autres instances sont intactes');
  console.log('\nRÉSULTAT : OK');
})().catch((e) => {
  console.error('\nÉCHEC :', e.message);
  process.exit(1);
});
