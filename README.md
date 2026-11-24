# Claude Switcher

**English** · [Français](README.fr.md)

Multi-account manager for **Claude Desktop** on macOS and Windows. Each Claude account
gets its own isolated profile. You sign in **once** per account, the normal way (email
code, Google, SSO, two-factor authentication). After that, one click or a keyboard
shortcut opens Claude Desktop on the account you choose, already signed in.

- Uses the official, unmodified Claude Desktop app.
- Never copies, reads or displays cookies or tokens.
- Built so that Claude Desktop's own updates keep working (see
  [Claude Desktop updates](#claude-desktop-updates)).
- Updates itself from this repository's GitHub Releases, with signed update manifests.

## Contents

- [Download and install](#download-and-install)
- [Usage](#usage)
- [How it works](#how-it-works)
- [Claude Desktop updates](#claude-desktop-updates)
- [Automatic updates of Claude Switcher](#automatic-updates-of-claude-switcher)
- [Publishing a release](#publishing-a-release)
- [Security and privacy](#security-and-privacy)
- [Limitations](#limitations)
- [Windows: where is Claude installed?](#windows-where-is-claude-installed)
- [Development](#development)

## Download and install

Download the latest version from the
[Releases page](https://github.com/aeroxfr/claude-switcher-account/releases/latest).

### macOS

1. Download `Claude-Switcher-<version>-mac-arm64.dmg` for Apple silicon, or
   `Claude-Switcher-<version>-mac-x64.dmg` for an Intel Mac.
2. Open the `.dmg` and drag **Claude Switcher** to **Applications**. Automatic updates only
   work from a folder you can write to, such as Applications.
3. The app is not notarized. The first time, right-click it and choose **Open**, then
   **Open** again. If macOS says the app "is damaged", run:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Claude Switcher.app"
   ```

### Windows

1. Download `Claude-Switcher-Setup-<version>.exe` and run it. A portable version,
   `Claude-Switcher-Portable-<version>.exe`, is also available; it does not update itself.
2. The installer is not code-signed. If SmartScreen appears, choose **More info** ›
   **Run anyway**.

Claude Switcher lives in the menu bar (macOS) or the notification area (Windows).

## Usage

The interface is in French; button names are given below in French with a translation.

1. **Main account**: your current Claude setup appears automatically as the main account.
   Use **⋯ › Modifier…** (Edit) to give it a name and an email address.
2. **Add an account**: click **Ajouter un compte** (Add account), then enter a name and an email address (used
   only for display). A blank Claude window opens. Sign in the normal way; you only do
   this once.
3. **Switch**: click **Basculer / Ouvrir** (Switch / Open) on an account, double-click it, or press **1–9** in
   the window. Global shortcuts: **⌘⌥1…9** on macOS, **Ctrl+Alt+1…9** on Windows.
   **⌘⌥0** or **Ctrl+Alt+0** shows the window. You can change the key combination in
   **Réglages** (Settings).
4. **Default account**: **⋯ › Définir par défaut** (Set as default, star). The tray menu can open it, and so can
   startup if you turn that option on.
5. **Backups**: **⋯ › Sauvegardes…** (Backups) while the account is closed. Caches and large files that
   can be downloaded again are skipped.
6. **Direct launch**: **⋯ › Raccourci sur le Bureau** (desktop shortcut, Windows) or
   **Copier la commande de lancement** (copy launch command, macOS; for Raycast, Alfred,
   Automator…):

   ```bash
   open -n -a "Claude Switcher" --args --open=default
   ```

   `--open=` accepts `default`, a number from 1 to 9, or an account's id, name or email.

By default only **one account is open at a time**: switching closes the other account
cleanly, never by force. You can allow several accounts open at once in Settings, but
see [Claude Desktop updates](#claude-desktop-updates) first.

## How it works

Claude Desktop is an Electron app. Everything that belongs to an account lives in one
data folder: the encrypted claude.ai session, encrypted OAuth tokens, Claude Code and
Cowork sessions, MCP configuration and caches. Claude Desktop accepts
`--user-data-dir=<folder>`, so Claude Switcher starts the official app with a separate
folder for each account.

| | Data folder |
|---|---|
| Main account | Claude's standard folder, launched **without** any option. Nothing is moved. |
| Added accounts | `~/Library/Application Support/Claude Switcher/profiles/<id>` (macOS) · `%USERPROFILE%\.claude-switcher\profiles\<id>` (Windows) |

| | macOS | Windows |
|---|---|---|
| Launch | `open -n -a Claude.app --args --user-data-dir=…` | MSIX installer: official Windows activation API (`IApplicationActivationManager`, `Claude_pzs8sxrjxfjjc!Claude`). Classic installer: stable launcher `AnthropicClaude\claude.exe`. |
| Bring an open account to the front | Activates that exact process by PID. No second instance is ever started, because Claude does not guard against two instances on one folder on macOS. | Relaunches on the same profile; Claude's per-profile single-instance lock brings its window back. A duplicate, if any, is closed. |
| Close an account | Normal quit signal | `taskkill` without `/F`. Claude may minimize to the notification area instead of quitting; you are told if so. |

## Claude Desktop updates

A switcher that moves or swaps Claude's folders can break Claude's own updates. Claude
Switcher is designed around how those updates work:

- **macOS**: Claude downloads updates into **one shared folder**,
  `~/Library/Caches/com.anthropic.claudefordesktop.ShipIt`, whatever the profile. Its
  installer (ShipIt) replaces `Claude.app` only when **every** Claude instance is closed.
  Several instances running at once block the install and compete for that folder, which
  shows up as `staging_gone`, then "Too many attempts to install".
- **Windows**: the MSIX package updates when Claude is closed. With the classic installer,
  each version lives in a new `app-x.y.z` folder that disappears at the next update.
- Updates cannot be turned off for a single profile. Only a machine-wide enterprise policy
  can do that, and Claude Switcher does not touch it.

What Claude Switcher does about it:

1. It never moves, renames or symlinks Claude's standard folder. It never modifies
   `Claude.app` or the ShipIt folder, and never stops Claude's installer.
2. One account at a time is the default. Allowing several requires an explicit
   confirmation.
3. Before opening an account, it waits for a Claude update that is being installed to
   finish (up to 3 minutes).
4. When a Claude update is ready, a banner offers **Installer maintenant** (Install now). Claude Switcher closes
   the open accounts cleanly, lets Claude's installer run, then reopens your account.
5. On Windows it never stores a versioned path. It launches the MSIX package by its
   identifier, or uses the stable launcher of the classic installer. If both installers
   are present, MSIX wins.
6. If Claude restarts on its own on the main account after an update, Claude Switcher
   tells you.

## Automatic updates of Claude Switcher

This section is about Claude Switcher itself, not Claude Desktop.

- It checks this repository's latest GitHub Release 15 s after startup, then every 6
  hours. You can turn this off, or check manually in **Réglages › Rechercher maintenant**
  (Settings › Check now).
- The new version is downloaded and verified, then a banner offers **Redémarrer** (Restart). Only
  Claude Switcher restarts; Claude stays open.
- **macOS**: it downloads the `.zip` for your architecture, extracts it, and checks the
  bundle's identifier, version and signature. After the app quits, a small script swaps
  the app bundle and relaunches it. If the swap fails, the previous version is put back.
- **Windows** (installed version): it runs the installer silently
  (`--updated /S --force-run`), which relaunches the app. The portable version shows a
  **Télécharger** (Download) button instead.

The packages are not signed with an Apple or Microsoft certificate, so every release
carries `latest.json` (file sizes and SHA-512 hashes) signed with **Ed25519**
(`latest.json.sig`). The app only embeds the public key (`src/update-key.js`). It rejects
an unsigned or tampered manifest, a manifest signed with another key, a file whose hash
does not match, and any older version. It only contacts `api.github.com`, `github.com`
and `*.githubusercontent.com` over HTTPS.

## Publishing a release

### One-time setup

1. Generate the signing key pair, unless `src/update-key.js` already holds yours:

   ```bash
   npm run release:keygen
   ```

   The private key is written to `~/.claude-switcher-release/update-signing-key.pem`.
   **Back it up** (for example in a password manager) and never commit it. Without it,
   existing installs will not accept new versions.
2. Add it as a repository secret named `UPDATE_SIGNING_KEY`: **Settings › Secrets and
   variables › Actions › New repository secret**, then paste the whole file. On macOS:

   ```bash
   pbcopy < ~/.claude-switcher-release/update-signing-key.pem
   ```

3. `package.json` → `"updateRepository": "aeroxfr/claude-switcher-account"` (already set).
   Only builds that contain this field know where to look for updates.

### Release with GitHub Actions (recommended)

The workflow `.github/workflows/release.yml` runs the tests, builds natively on macOS
(arm64 + x64 `.zip` and `.dmg`) and Windows (installer + portable), signs the manifest
and publishes the Release.

1. Bump `"version"` in `package.json` (for example 1.0.0 → 1.0.1) and commit.
2. Push a matching tag:

   ```bash
   git tag v1.0.1
   ```

   ```bash
   git push origin main v1.0.1
   ```

   You can also start it from **Actions › Release › Run workflow**; the tag is then
   created for you.

The workflow refuses a tag that does not match `package.json`, and a version that is not
newer than the latest Release.

### Release from a Mac (alternative)

This builds macOS packages natively and cross-builds Windows packages. The private key
never leaves your Mac.

```bash
GH_TOKEN=<token> npm run release -- --notes "What changed"
```

The token must be a fine-grained token limited to this repository, with **Contents: Read
and write**. Options: `--dry-run` prepares and signs everything without publishing,
`--draft` creates a draft Release, and `--skip-build` reuses `dist/`.

Installs pick up the new version within 6 hours, or straight away with **Rechercher
maintenant** (Check now).

## Security and privacy

- Claude Switcher stores **no credentials and no tokens**. `accounts.json` only holds
  names, display emails, colors, order and settings.
- Sessions stay inside each profile, encrypted by Claude itself (macOS Keychain or
  Windows DPAPI).
- To show the sign-in status ("Connecté", "Session : N j restants"), the app reads **only the expiry date** of the session
  cookie, from the `expires_utc` column with the database opened read-only. It never reads
  the cookie's value.
- The window runs with `contextIsolation`, `sandbox` and a strict Content Security Policy.
  IPC calls are accepted only from the app's own window.
- Nothing is permanently deleted. A removed account, or anything replaced by a restore,
  goes to the app's `corbeille/` (trash) folder.

## Limitations

- **Several accounts open at once**: Claude can only install its updates once every
  account is closed. Use **Installer maintenant** (Install now) when a Claude update is ready.
- **Shared between accounts**: `~/.claude` (Claude Code settings, memory and skills),
  Claude's logs, and the "Claude Safe Storage" encryption key.
- **Claude in Chrome**: Claude disables local pairing in a relocated profile, so the
  extension pairs only with the main account.
- **Disk space**: each profile downloads its own Claude Code binary (about 350 MB), plus
  the Cowork virtual machine (about 11 GB) if you use Cowork in that account.
- **Sessions**: an account unused for about 30 days has to sign in again. The expiry date
  moves forward each time you use the account.
- **Windows sign-in**: for an added account's first sign-in, prefer **Continue with
  email**. The browser return from Google or SSO (`claude://`) lands in the main account.
- **Windows testing**: covered by unit tests and native CI builds, but less tested in real
  use than macOS.

## Windows: where is Claude installed?

You don't need to look for it: **Réglages › Détection automatique** (Settings › Auto-detect)
finds it. Recent versions of
Claude Desktop install as an **MSIX package** under `C:\Program Files\WindowsApps\…`, a
protected folder you cannot browse. To check by hand, in PowerShell:

```powershell
Get-AppxPackage -Name *Claude* | Select-Object Name, PackageFamilyName, Version, InstallLocation
```

If nothing appears, look for the classic installer:

```powershell
Test-Path "$env:LOCALAPPDATA\AnthropicClaude\claude.exe"
```

With MSIX, the main account's data is in
`%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude`, not in
`%APPDATA%\Claude`. Claude Code on the command line (`%USERPROFILE%\.local\bin\claude.exe`)
is a separate tool: Claude Switcher drives Claude Desktop, which also contains the Code
tab.

## Development

Requires Node.js 22 or later.

```bash
npm install
```

```bash
npm start
```

```bash
npm test
```

- `node dev/integration.js` runs an integration test with the real Claude Desktop on a
  throwaway profile: open, bring to the front without a duplicate, close cleanly. The
  test instance may itself start preparing a Claude update in the shared ShipIt folder.
- `dev/preview.html` previews the interface in a browser with a mocked API (add
  `?os=win32` for the Windows look).
- `node dev/fake-github.js <packages-folder> <version>` serves a signed fake Release on
  127.0.0.1. Start the app with `CLAUDE_SWITCHER_UPDATE_TEST_API=http://127.0.0.1:8790`
  and `CLAUDE_SWITCHER_UPDATE_TEST_REPO=test/claude-switcher`. The signature is still
  required.
- `npm run icons` regenerates the icons.

```
src/main.js          lifecycle, window, tray, global shortcuts, IPC, switching
src/platform.js      find / launch / detect / activate / close Claude (macOS, Windows)
src/windows.js       Windows MSIX detection and activation
src/updates.js       Claude Desktop update safeguards (read-only)
src/updater.js       Claude Switcher self-update from GitHub Releases
src/update-core.js   manifest and signature checks (pure functions)
src/update-key.js    Ed25519 public key for updates
src/profiles.js      profile folders, sign-in status, backup / restore, trash
src/store.js         accounts.json (metadata only), atomic writes + .bak
src/preload.js       secure bridge (contextIsolation, sandbox)
src/renderer/        interface (plain HTML/CSS/JS, no HTML injection)
scripts/             release, key generation, icons
.github/workflows/   release pipeline (macOS + Windows)
```

The app's own data lives in `~/Library/Application Support/Claude Switcher` (macOS) or
`%USERPROFILE%\.claude-switcher` (Windows): `accounts.json`, `profiles/`, `backups/`,
`corbeille/` (trash) and `app/switcher.log`. To uninstall, delete the app and, if you
wish, that folder. This removes the added accounts; the main account (Claude's standard
profile) is not affected.

Claude Switcher is an independent project, not affiliated with Anthropic.
