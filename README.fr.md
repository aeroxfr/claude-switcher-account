# Claude Switcher

[English](README.md) · **Français**

Gestionnaire multi-comptes pour **Claude Desktop** sur macOS et Windows. Chaque compte
Claude dispose de son propre profil isolé. Vous vous connectez **une seule fois** par compte,
normalement (code par e-mail, Google, SSO, double authentification). Ensuite, un clic ou un
raccourci clavier ouvre Claude Desktop sur le compte choisi, déjà connecté.

- Utilise l'application officielle Claude Desktop, non modifiée.
- Ne copie, ne lit et n'affiche jamais de cookie ni de jeton.
- Conçu pour que les mises à jour de Claude Desktop continuent de fonctionner (voir
  [Mises à jour de Claude Desktop](#mises-à-jour-de-claude-desktop)).
- Se met à jour tout seul depuis les Releases GitHub de ce dépôt, avec des manifestes
  signés.

## Sommaire

- [Télécharger et installer](#télécharger-et-installer)
- [Utilisation](#utilisation)
- [Fonctionnement](#fonctionnement)
- [Mises à jour de Claude Desktop](#mises-à-jour-de-claude-desktop)
- [Mises à jour automatiques de Claude Switcher](#mises-à-jour-automatiques-de-claude-switcher)
- [Publier une version](#publier-une-version)
- [Sécurité et confidentialité](#sécurité-et-confidentialité)
- [Limites](#limites)
- [Windows : où est installé Claude ?](#windows--où-est-installé-claude-)
- [Développement](#développement)

## Télécharger et installer

Téléchargez la dernière version sur la
[page des Releases](https://github.com/aeroxfr/claude-switcher-account/releases/latest).

### macOS

1. Téléchargez `Claude-Switcher-<version>-mac-arm64.dmg` pour un Mac Apple Silicon, ou
   `Claude-Switcher-<version>-mac-x64.dmg` pour un Mac Intel.
2. Ouvrez le `.dmg` et glissez **Claude Switcher** dans **Applications**. Les mises à jour
   automatiques ne fonctionnent que depuis un dossier modifiable, comme Applications.
3. L'application n'est pas notarisée. La première fois, faites un clic droit dessus,
   choisissez **Ouvrir**, puis **Ouvrir** à nouveau. Si macOS indique qu'elle est
   « endommagée », lancez :

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Claude Switcher.app"
   ```

### Windows

1. Téléchargez `Claude-Switcher-Setup-<version>.exe` et lancez-le. Une version portable,
   `Claude-Switcher-Portable-<version>.exe`, est aussi proposée ; elle ne se met pas à jour
   toute seule.
2. L'installateur n'est pas signé. Si SmartScreen s'affiche, choisissez **Informations
   complémentaires** › **Exécuter quand même**.

Claude Switcher se trouve dans la barre de menus (macOS) ou dans la zone de notification
(Windows).

## Utilisation

1. **Compte principal** : votre configuration actuelle de Claude apparaît automatiquement
   comme compte principal. Menu **⋯ › Modifier…** pour lui donner un nom et une adresse
   e-mail.
2. **Ajouter un compte** : cliquez sur **Ajouter un compte**, puis indiquez un nom et une
   adresse e-mail (servant seulement à l'affichage). Une fenêtre Claude vierge s'ouvre.
   Connectez-vous normalement ; vous ne le ferez qu'une fois.
3. **Basculer** : bouton **Basculer / Ouvrir** sur un compte, double-clic, ou touches
   **1 à 9** dans la fenêtre. Raccourcis globaux : **⌘⌥1…9** sur macOS, **Ctrl+Alt+1…9**
   sur Windows. **⌘⌥0** ou **Ctrl+Alt+0** affiche la fenêtre. La combinaison se modifie
   dans les **Réglages**.
4. **Compte par défaut** : **⋯ › Définir par défaut** (étoile). Le menu de l'icône peut
   l'ouvrir, de même que le démarrage si vous activez l'option.
5. **Sauvegardes** : **⋯ › Sauvegardes…**, compte fermé. Les caches et les gros fichiers
   retéléchargeables sont exclus.
6. **Lancement direct** : **⋯ › Raccourci sur le Bureau** (Windows) ou **Copier la commande
   de lancement** (macOS ; pour Raycast, Alfred, Automator…) :

   ```bash
   open -n -a "Claude Switcher" --args --open=default
   ```

   `--open=` accepte `default`, un numéro de 1 à 9, ou l'identifiant, le nom ou l'e-mail
   d'un compte.

Par défaut, **un seul compte est ouvert à la fois** : basculer ferme proprement l'autre
compte, jamais de force. Vous pouvez autoriser plusieurs comptes ouverts en même temps
dans les Réglages, mais lisez d'abord
[Mises à jour de Claude Desktop](#mises-à-jour-de-claude-desktop).

## Fonctionnement

Claude Desktop est une application Electron. Tout ce qui appartient à un compte se trouve
dans un seul dossier de données : session claude.ai chiffrée, jetons OAuth chiffrés,
sessions Claude Code et Cowork, configuration MCP et caches. Claude Desktop accepte
`--user-data-dir=<dossier>` ; Claude Switcher lance donc l'application officielle avec un
dossier distinct par compte.

| | Dossier de données |
|---|---|
| Compte principal | Dossier standard de Claude, lancé **sans** aucune option. Rien n'est déplacé. |
| Comptes ajoutés | `~/Library/Application Support/Claude Switcher/profiles/<id>` (macOS) · `%USERPROFILE%\.claude-switcher\profiles\<id>` (Windows) |

| | macOS | Windows |
|---|---|---|
| Lancement | `open -n -a Claude.app --args --user-data-dir=…` | Installateur MSIX : API officielle d'activation de Windows (`IApplicationActivationManager`, `Claude_pzs8sxrjxfjjc!Claude`). Installateur classique : lanceur stable `AnthropicClaude\claude.exe`. |
| Remettre au premier plan un compte ouvert | Activation de ce processus précis par son PID. Aucune seconde instance n'est jamais lancée, car sur macOS Claude ne se protège pas contre deux instances sur un même dossier. | Relance sur le même profil ; le verrou d'instance unique par profil de Claude réaffiche sa fenêtre. Un éventuel doublon est refermé. |
| Fermer un compte | Signal de fermeture normal | `taskkill` sans `/F`. Claude peut se réduire dans la zone de notification au lieu de quitter ; vous en êtes averti. |

## Mises à jour de Claude Desktop

Un outil qui déplace ou échange les dossiers de Claude peut casser ses mises à jour.
Claude Switcher est conçu en fonction de leur fonctionnement :

- **macOS** : Claude télécharge ses mises à jour dans **un dossier unique et partagé**,
  `~/Library/Caches/com.anthropic.claudefordesktop.ShipIt`, quel que soit le profil. Son
  installateur (ShipIt) ne remplace `Claude.app` que lorsque **toutes** les instances de
  Claude sont fermées. Plusieurs instances ouvertes en même temps bloquent l'installation
  et se disputent ce dossier, ce qui donne `staging_gone`, puis « Too many attempts to
  install ».
- **Windows** : le paquet MSIX se met à jour quand Claude est fermé. Avec l'installateur
  classique, chaque version occupe un nouveau dossier `app-x.y.z`, qui disparaît à la mise
  à jour suivante.
- Il est impossible de désactiver les mises à jour pour un seul profil. Seule une politique
  d'entreprise, valable pour toute la machine, le permet, et Claude Switcher n'y touche pas.

Ce que fait Claude Switcher :

1. Il ne déplace, ne renomme et ne remplace jamais par un lien le dossier standard de
   Claude. Il ne modifie jamais `Claude.app` ni le dossier ShipIt, et n'arrête jamais
   l'installateur de Claude.
2. Un seul compte ouvert à la fois par défaut. En autoriser plusieurs demande une
   confirmation explicite.
3. Avant d'ouvrir un compte, il attend la fin d'une mise à jour de Claude en cours
   d'installation (jusqu'à 3 minutes).
4. Quand une mise à jour de Claude est prête, un bandeau propose **Installer maintenant**.
   Claude Switcher ferme proprement les comptes ouverts, laisse l'installateur de Claude
   travailler, puis rouvre votre compte.
5. Sous Windows, il n'enregistre jamais de chemin versionné. Il lance le paquet MSIX par
   son identifiant, ou le lanceur stable de l'installateur classique. Si les deux sont
   présents, MSIX est prioritaire.
6. Si Claude redémarre tout seul sur le compte principal après une mise à jour, Claude
   Switcher vous prévient.

## Mises à jour automatiques de Claude Switcher

Cette partie concerne Claude Switcher lui-même, pas Claude Desktop.

- Il consulte la dernière Release GitHub de ce dépôt 15 s après son démarrage, puis toutes
  les 6 heures. Vous pouvez désactiver cette vérification, ou la lancer à la main dans
  **Réglages › Rechercher maintenant**.
- La nouvelle version est téléchargée et vérifiée, puis un bandeau propose
  **Redémarrer**. Seul Claude Switcher redémarre ; Claude reste ouvert.
- **macOS** : il télécharge le `.zip` de votre processeur, l'extrait, et contrôle
  l'identifiant, la version et la signature du bundle. Après la fermeture de
  l'application, un petit script remplace le bundle et la relance. Si le remplacement
  échoue, l'ancienne version est remise en place.
- **Windows** (version installée) : il lance l'installateur en mode silencieux
  (`--updated /S --force-run`), qui relance l'application. La version portable affiche
  plutôt un bouton **Télécharger**.

Les paquets ne sont pas signés par un certificat Apple ou Microsoft. Chaque Release contient
donc `latest.json` (tailles et empreintes SHA-512 des fichiers), signé en **Ed25519**
(`latest.json.sig`). L'application n'embarque que la clé publique (`src/update-key.js`).
Elle refuse un manifeste non signé ou modifié, un manifeste signé par une autre clé, un
fichier dont l'empreinte ne correspond pas, et toute version plus ancienne. Elle ne
contacte que `api.github.com`, `github.com` et `*.githubusercontent.com`, en HTTPS.

## Publier une version

### Mise en place (une fois)

1. Générez la paire de clés de signature, sauf si `src/update-key.js` contient déjà la
   vôtre :

   ```bash
   npm run release:keygen
   ```

   La clé privée est écrite dans `~/.claude-switcher-release/update-signing-key.pem`.
   **Sauvegardez-la** (par exemple dans un gestionnaire de mots de passe) et ne la versionnez
   jamais. Sans elle, les installations existantes n'accepteront plus de nouvelle version.
2. Ajoutez-la comme secret du dépôt, sous le nom `UPDATE_SIGNING_KEY` : **Settings ›
   Secrets and variables › Actions › New repository secret**, puis collez le fichier en
   entier. Sur macOS :

   ```bash
   pbcopy < ~/.claude-switcher-release/update-signing-key.pem
   ```

3. `package.json` → `"updateRepository": "aeroxfr/claude-switcher-account"` (déjà
   renseigné). Seules les versions qui contiennent ce champ savent où chercher les mises à
   jour.

### Publier avec GitHub Actions (recommandé)

Le workflow `.github/workflows/release.yml` lance les tests, construit nativement sur
macOS (`.zip` et `.dmg` arm64 + x64) et sur Windows (installateur + portable), signe le
manifeste et publie la Release.

1. Augmentez `"version"` dans `package.json` (par exemple 1.0.0 → 1.0.1) et committez.
2. Poussez le tag correspondant :

   ```bash
   git tag v1.0.1
   ```

   ```bash
   git push origin main v1.0.1
   ```

   Vous pouvez aussi le lancer depuis **Actions › Release › Run workflow** ; le tag est
   alors créé pour vous.

Le workflow refuse un tag qui ne correspond pas à `package.json`, et une version qui n'est
pas plus récente que la dernière Release.

### Publier depuis un Mac (alternative)

Les paquets macOS sont construits nativement et les paquets Windows en compilation croisée.
La clé privée ne quitte jamais votre Mac.

```bash
GH_TOKEN=<jeton> npm run release -- --notes "Ce qui change"
```

Le jeton doit être un jeton « fine-grained » limité à ce dépôt, avec le droit **Contents :
Read and write**. Options : `--dry-run` prépare et signe tout sans publier, `--draft` crée
une Release en brouillon, et `--skip-build` réutilise `dist/`.

Les installations récupèrent la nouvelle version dans les 6 heures, ou tout de suite avec
**Rechercher maintenant**.

## Sécurité et confidentialité

- Claude Switcher ne stocke **aucun identifiant ni jeton**. `accounts.json` ne contient que
  les noms, les e-mails affichés, les couleurs, l'ordre et les réglages.
- Les sessions restent dans chaque profil, chiffrées par Claude lui-même (Trousseau macOS
  ou DPAPI Windows).
- Pour afficher l'état de connexion (« Connecté », « Session : N j restants »),
  l'application lit **uniquement la date d'expiration** du cookie de session, dans la colonne
  `expires_utc`, base ouverte en lecture seule. Elle ne lit jamais la valeur du cookie.
- La fenêtre fonctionne avec `contextIsolation`, `sandbox` et une politique de sécurité du
  contenu (CSP) stricte. Les appels IPC ne sont acceptés que depuis la fenêtre de
  l'application.
- Rien n'est supprimé définitivement. Un compte retiré, ou ce qu'une restauration remplace,
  va dans le dossier `corbeille/` de l'application.

## Limites

- **Plusieurs comptes ouverts en même temps** : Claude ne peut installer ses mises à jour
  qu'une fois tous les comptes fermés. Utilisez **Installer maintenant** quand une mise à
  jour de Claude est prête.
- **Partagé entre les comptes** : `~/.claude` (réglages, mémoire et skills de Claude Code),
  les journaux de Claude, et la clé de chiffrement « Claude Safe Storage ».
- **Claude in Chrome** : Claude désactive l'appairage local dans un profil déplacé ;
  l'extension ne s'appaire donc qu'avec le compte principal.
- **Espace disque** : chaque profil télécharge son propre binaire Claude Code (environ
  350 Mo), plus la machine virtuelle Cowork (environ 11 Go) si vous utilisez Cowork dans ce
  compte.
- **Sessions** : un compte inutilisé pendant environ 30 jours doit se reconnecter. La date
  d'expiration recule à chaque utilisation du compte.
- **Connexion sous Windows** : pour la première connexion d'un compte ajouté, préférez
  **Continuer avec l'e-mail**. Le retour d'une connexion Google ou SSO par le navigateur
  (`claude://`) arrive sur le compte principal.
- **Tests sous Windows** : couvert par les tests automatiques et les compilations natives
  de la CI, mais moins éprouvé en usage réel que macOS.

## Windows : où est installé Claude ?

Inutile de le chercher : **Réglages › Détection automatique** le trouve. Les versions
récentes de Claude Desktop s'installent en **paquet MSIX** dans
`C:\Program Files\WindowsApps\…`, un dossier protégé qu'on ne peut pas parcourir. Pour
vérifier à la main, dans PowerShell :

```powershell
Get-AppxPackage -Name *Claude* | Select-Object Name, PackageFamilyName, Version, InstallLocation
```

Si rien n'apparaît, cherchez l'installateur classique :

```powershell
Test-Path "$env:LOCALAPPDATA\AnthropicClaude\claude.exe"
```

Avec MSIX, les données du compte principal se trouvent dans
`%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude`, et non dans
`%APPDATA%\Claude`. Claude Code en ligne de commande (`%USERPROFILE%\.local\bin\claude.exe`)
est un outil distinct : Claude Switcher pilote Claude Desktop, qui contient aussi l'onglet
Code.

## Développement

Nécessite Node.js 22 ou plus récent.

```bash
npm install
```

```bash
npm start
```

```bash
npm test
```

- `node dev/integration.js` lance un test d'intégration avec le vrai Claude Desktop, sur un
  profil jetable : ouverture, remise au premier plan sans doublon, fermeture propre.
  L'instance de test peut elle-même relancer la préparation d'une mise à jour de Claude
  dans le dossier ShipIt partagé.
- `dev/preview.html` affiche l'interface dans un navigateur avec une API simulée (ajoutez
  `?os=win32` pour l'aspect Windows).
- `node dev/fake-github.js <dossier-des-paquets> <version>` sert une fausse Release signée
  sur 127.0.0.1. Lancez ensuite l'application avec
  `CLAUDE_SWITCHER_UPDATE_TEST_API=http://127.0.0.1:8790` et
  `CLAUDE_SWITCHER_UPDATE_TEST_REPO=test/claude-switcher`. La signature reste exigée.
- `npm run icons` régénère les icônes.

```
src/main.js          cycle de vie, fenêtre, icône, raccourcis globaux, IPC, bascule
src/platform.js      trouver / lancer / détecter / activer / fermer Claude (macOS, Windows)
src/windows.js       détection et activation du paquet MSIX de Claude sous Windows
src/updates.js       garde-fous des mises à jour de Claude Desktop (lecture seule)
src/updater.js       mise à jour de Claude Switcher depuis les Releases GitHub
src/update-core.js   vérification du manifeste et de la signature (fonctions pures)
src/update-key.js    clé publique Ed25519 des mises à jour
src/profiles.js      dossiers de profil, état de connexion, sauvegarde / restauration, corbeille
src/store.js         accounts.json (métadonnées seulement), écriture atomique + .bak
src/preload.js       pont sécurisé (contextIsolation, sandbox)
src/renderer/        interface (HTML/CSS/JS sans framework, sans injection HTML)
scripts/             publication, génération de clés, icônes
.github/workflows/   chaîne de publication (macOS + Windows)
```

Les données de l'application se trouvent dans `~/Library/Application Support/Claude Switcher`
(macOS) ou `%USERPROFILE%\.claude-switcher` (Windows) : `accounts.json`, `profiles/`,
`backups/`, `corbeille/` et `app/switcher.log`. Pour désinstaller, supprimez l'application
puis, si vous le souhaitez, ce dossier. Cela supprime les comptes ajoutés ; le compte
principal (profil standard de Claude) n'est pas concerné.

Claude Switcher est un projet indépendant, sans lien avec Anthropic.
