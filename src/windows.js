'use strict';
/**
 * Spécificités Windows : installation MSIX (« installateur moderne ») de
 * Claude Desktop.
 *
 * - Paquets connus : « Claude » (installateur Anthropic, famille
 *   Claude_pzs8sxrjxfjjc) et « AnthropicPBC.Claude » (Microsoft Store, famille
 *   AnthropicPBC.Claude_fnn82j28hfe8t). Identifiant d'application : <famille>!Claude.
 * - L'exécutable se trouve dans C:\Program Files\WindowsApps\…, un dossier que
 *   Windows interdit de parcourir : on ne le choisit pas à la main, on le
 *   détecte avec Get-AppxPackage.
 * - Lancement avec arguments : API officielle IApplicationActivationManager
 *   (l'application garde son identité de paquet, donc ses mises à jour MSIX).
 * - Données du profil standard : AppData est virtualisé ; Claude utilise
 *   %LOCALAPPDATA%\Packages\<famille>\LocalCache\Roaming\Claude dès que ce
 *   dossier existe, sinon %APPDATA%\Claude.
 */
const path = require('node:path');

const MSIX_PACKAGE_NAMES = ['Claude', 'AnthropicPBC.Claude'];
const KNOWN_FAMILIES = ['Claude_pzs8sxrjxfjjc', 'AnthropicPBC.Claude_fnn82j28hfe8t'];
const MSIX_PREFIX = 'shell:AppsFolder\\';

const FAMILY_RE = /^[A-Za-z0-9.-]+_[a-z0-9]{13}$/;
const APP_ID_RE = /^[A-Za-z][A-Za-z0-9.]*$/;

/** Cible MSIX (shell:AppsFolder\<famille>!<app>) plutôt qu'un chemin d'exécutable. */
function isMsixTarget(p) {
  return typeof p === 'string' && p.toLowerCase().startsWith(MSIX_PREFIX.toLowerCase());
}

function msixTarget(aumid) {
  return MSIX_PREFIX + aumid;
}

function aumidOf(target) {
  const a = String(target).slice(MSIX_PREFIX.length);
  const [family, app] = a.split('!');
  if (!FAMILY_RE.test(family || '') || !APP_ID_RE.test(app || '')) throw new Error(`Identifiant d'application invalide : ${a}`);
  return a;
}

/** Script PowerShell : paquet MSIX de Claude installé (le plus récent), en JSON. */
const FIND_MSIX_PS = [
  "$ErrorActionPreference='SilentlyContinue'",
  `$pk = @(${MSIX_PACKAGE_NAMES.map((n) => `Get-AppxPackage -Name '${n}'`).join('; ')}) | Where-Object { $_ } | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1`,
  'if ($pk) {',
  '  $app = @((Get-AppxPackageManifest -Package $pk.PackageFullName).Package.Applications.Application)[0]',
  '  [pscustomobject]@{ family = [string]$pk.PackageFamilyName; name = [string]$pk.Name; version = [string]$pk.Version; installLocation = [string]$pk.InstallLocation; appId = [string]$app.Id; executable = [string]$app.Executable } | ConvertTo-Json -Compress',
  '}',
].join('\n');

/** Analyse la sortie de FIND_MSIX_PS. Renvoie null si rien d'exploitable. */
function parseMsixInfo(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  let d;
  try {
    d = JSON.parse(txt);
  } catch {
    return null;
  }
  if (!d || !FAMILY_RE.test(d.family || '')) return null;
  const appId = APP_ID_RE.test(d.appId || '') ? d.appId : 'Claude';
  const exe = d.installLocation && d.executable ? path.win32.join(d.installLocation, d.executable) : null;
  return {
    family: d.family,
    name: d.name || null,
    version: d.version || null,
    installLocation: d.installLocation || null,
    exe,
    aumid: `${d.family}!${appId}`,
    store: /^AnthropicPBC\./.test(d.family),
  };
}

/**
 * Script PowerShell : active l'application MSIX avec des arguments via
 * IApplicationActivationManager. L'identifiant et les arguments arrivent par
 * variables d'environnement (CS_AUMID, CS_ARGS) : aucune interpolation.
 */
const ACTIVATE_MSIX_PS = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'namespace ClaudeSwitcher {',
  '  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  '  public interface IApplicationActivationManager {',
  '    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, int options, out uint processId);',
  '    [PreserveSig] int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr itemArray, [MarshalAs(UnmanagedType.LPWStr)] string verb, out uint processId);',
  '    [PreserveSig] int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr itemArray, out uint processId);',
  '  }',
  '  [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]',
  '  public class ApplicationActivationManager { }',
  '  public static class Launcher {',
  '    public static uint Activate(string aumid, string args) {',
  '      var m = (IApplicationActivationManager)new ApplicationActivationManager();',
  '      uint pid;',
  '      int hr = m.ActivateApplication(aumid, args, 0, out pid);',
  '      if (hr < 0) Marshal.ThrowExceptionForHR(hr);',
  '      return pid;',
  '    }',
  '  }',
  '}',
  "'@",
  '[ClaudeSwitcher.Launcher]::Activate($env:CS_AUMID, $env:CS_ARGS)',
].join('\n');

/** Met un argument --clé=valeur en forme sûre pour une ligne de commande Windows. */
function quoteWinArg(arg) {
  const s = String(arg);
  if (!/[\s"]/.test(s)) return s;
  const eq = s.indexOf('=');
  if (s.startsWith('--') && eq > 0) {
    const value = s.slice(eq + 1).replace(/"/g, '');
    return `${s.slice(0, eq + 1)}"${value.replace(/\\+$/, '')}"`;
  }
  return `"${s.replace(/"/g, '').replace(/\\+$/, '')}"`;
}

/** Version d'une instance MSIX d'après son chemin (…\WindowsApps\Claude_1.2.3.0_x64__hash\…). */
function msixVersionOf(exePath) {
  const m = String(exePath || '').match(/[\\/]WindowsApps[\\/][^\\/_]+_(\d+(?:\.\d+)*)_[^\\/]*__[a-z0-9]{13}[\\/]/i);
  return m ? m[1] : null;
}

/** Dossiers de données possibles du profil standard sous MSIX, par ordre de priorité. */
function msixUserDataCandidates(localAppData, families = KNOWN_FAMILIES) {
  return families.map((f) => path.win32.join(localAppData, 'Packages', f, 'LocalCache', 'Roaming', 'Claude'));
}

module.exports = {
  MSIX_PACKAGE_NAMES,
  KNOWN_FAMILIES,
  MSIX_PREFIX,
  isMsixTarget,
  msixTarget,
  aumidOf,
  FIND_MSIX_PS,
  parseMsixInfo,
  ACTIVATE_MSIX_PS,
  quoteWinArg,
  msixVersionOf,
  msixUserDataCandidates,
};
