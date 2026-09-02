<#
.SYNOPSIS
    Builds SeekyVS and installs it into the main hive of each target VS instance.

.DESCRIPTION
    Everything is read from the built VSIX's manifest — version, publisher, display name — so a
    version bump needs no edit here. Previously installed versions are unregistered first, which a
    plain re-extract cannot do once the version changes the directory name.

    SCOPE IS THE POINT. This installs hive-scoped (no --PerMachine, no elevation). An
    install-scoped copy lands in <VS>\Common7\IDE\VSExtensions, loads into every hive including
    the experimental one, and outranks the copy F5 registers there — silently shadowing the build
    you are debugging, with no error anywhere. The script refuses to run if it finds one.

.PARAMETER InstanceId
    VS instance ids to target. Defaults to every VS 2026 (18.x) instance vswhere reports.

.PARAMETER Configuration
    Build configuration to deploy. Release by default.

.PARAMETER NoBuild
    Deploy the VSIX already on disk instead of building first.

.PARAMETER Uninstall
    Remove every installed version instead of installing.

.EXAMPLE
    .\deploy.ps1
    Build Release and install into every VS 2026 instance.

.EXAMPLE
    .\deploy.ps1 -InstanceId cfa335b4 -NoBuild
    Install the current build into the Insiders instance only.
#>
[CmdletBinding()]
param(
    [string[]] $InstanceId,
    [string]   $Configuration = 'Release',
    [switch]   $NoBuild,
    [switch]   $Uninstall
)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot

function Get-VsInstance {
    param([string[]] $Wanted)

    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) { throw "vswhere not found: $vswhere" }

    $all = & $vswhere -prerelease -all -format json | ConvertFrom-Json
    # 18.x is VS 2026; this extension's manifest targets [17.14,) but the out-of-proc host layout
    # and the finalizer path below are only verified against 2026.
    $candidates = $all | Where-Object { $_.installationVersion -like '18.*' }

    if ($Wanted) {
        $candidates = $candidates | Where-Object { $Wanted -contains $_.instanceId }
        $missing = $Wanted | Where-Object { $_ -notin $candidates.instanceId }
        if ($missing) { throw "No VS 2026 instance with id: $($missing -join ', ')" }
    }

    if (-not $candidates) { throw 'No VS 2026 (18.x) instance found.' }
    $candidates
}

function Get-InstallScopedCopy {
    <#
        Install-scoped copies of THIS extension, which is the trap. Matched on the manifest's
        extension id, not on directory names: other publishers install per-machine here quite
        legitimately (the directory names are opaque), and only our own id can shadow the copy F5
        deploys to the experimental hive.
    #>
    param([string] $InstallationPath, [string] $ExtensionId)

    $dir = Join-Path $InstallationPath 'Common7\IDE\VSExtensions'
    if (-not (Test-Path $dir)) { return @() }

    Get-ChildItem $dir -Directory | Where-Object Name -ne 'Microsoft' | Where-Object {
        $m = Get-ChildItem $_.FullName -Recurse -Depth 2 -Filter 'extension.vsixmanifest' -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $m) { return $false }
        try { ([xml](Get-Content $m.FullName -Raw)).PackageManifest.Metadata.Identity.Id -eq $ExtensionId }
        catch { $false }
    }
}

# --------------------------------------------------------------------------- guards
# The install-scope guard needs the extension id, so it runs after the manifest is read below.

if (Get-Process devenv -ErrorAction SilentlyContinue) {
    throw 'Close every Visual Studio instance first — the finalizer writes into hives VS has open.'
}

# --------------------------------------------------------------------------- build

if (-not $NoBuild -and -not $Uninstall) {
    Write-Host "Building $Configuration ..." -ForegroundColor Cyan
    & dotnet build (Join-Path $repo 'SeekyVS\SeekyVS.csproj') -c $Configuration -v:m --nologo
    if ($LASTEXITCODE -ne 0) { throw "Build failed ($LASTEXITCODE)." }
}

$vsix = Get-ChildItem (Join-Path $repo "SeekyVS\bin\$Configuration") -Recurse -Filter 'SeekyVS.vsix' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $vsix) { throw "No SeekyVS.vsix under SeekyVS\bin\$Configuration. Build first." }

# --------------------------------------------------------------------------- manifest

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($vsix.FullName)
try {
    $entry = $zip.Entries | Where-Object Name -eq 'extension.vsixmanifest'
    if (-not $entry) { throw "No extension.vsixmanifest inside $($vsix.FullName)" }
    $reader = New-Object IO.StreamReader($entry.Open())
    $manifest = [xml] $reader.ReadToEnd()
    $reader.Close()
} finally { $zip.Dispose() }

$identity    = $manifest.PackageManifest.Metadata.Identity
$extensionId = $identity.Id
$version     = $identity.Version
$publisher   = $identity.Publisher
$displayName = $manifest.PackageManifest.Metadata.DisplayName

Write-Host "$displayName $version by $publisher" -ForegroundColor Cyan
Write-Host "  $extensionId"
Write-Host "  $($vsix.FullName)  ($($vsix.LastWriteTime))"

# Now that the id is known: refuse to deploy over an install-scoped copy of ourselves. It loads
# into every hive, outranks what F5 registers in the experimental one, and produces no error —
# just a debug session that silently runs the wrong build.
foreach ($instance in Get-VsInstance $InstanceId) {
    $shadow = @(Get-InstallScopedCopy $instance.installationPath $extensionId)
    if ($shadow) {
        throw @"
$displayName is installed PER-MACHINE in $($instance.displayName) ($($instance.instanceId)):
  $($shadow.FullName -join "`n  ")
That copy loads into every hive and shadows whatever F5 deploys to the experimental one. Remove it
first, from an elevated prompt:
  & '$(Join-Path $instance.installationPath 'Common7\IDE\Microsoft.VisualStudio.Extensibility.Finalizer.exe')' ``
      --ExtensionOperations '$($shadow[0].FullName);uninstall' --PerMachine
"@
    }
}

# --------------------------------------------------------------------------- deploy

foreach ($instance in Get-VsInstance $InstanceId) {
    $id = $instance.instanceId
    $finalizer = Join-Path $instance.installationPath 'Common7\IDE\Microsoft.VisualStudio.Extensibility.Finalizer.exe'
    if (-not (Test-Path $finalizer)) {
        Write-Warning "No finalizer in $($instance.displayName) ($id) — skipping."
        continue
    }

    # Layout observed on 18.9: VSExtensions\<Publisher>\<DisplayName>\<Version>.
    $root = Join-Path $env:LOCALAPPDATA "Microsoft\VisualStudio\18.0_$id\VSExtensions\$publisher\$displayName"

    Write-Host "`n=== $($instance.displayName) ($id) ===" -ForegroundColor Green

    # Every existing version, not just the one being replaced: a version bump changes the
    # directory name, so re-extracting alone would leave the old one registered alongside.
    if (Test-Path $root) {
        foreach ($installed in Get-ChildItem $root -Directory) {
            Write-Host "  uninstalling $($installed.Name)" -ForegroundColor Yellow
            & $finalizer --ExtensionOperations "$($installed.FullName);uninstall" --InstanceId $id | Out-Null
            if ([IO.Directory]::Exists($installed.FullName)) {
                [IO.Directory]::Delete($installed.FullName, $true)
            }
        }
    }

    if ($Uninstall) {
        Write-Host '  uninstalled.' -ForegroundColor Green
        continue
    }

    $dest = Join-Path $root $version
    [IO.Directory]::CreateDirectory($dest) | Out-Null
    [IO.Compression.ZipFile]::ExtractToDirectory($vsix.FullName, $dest)

    & $finalizer --ExtensionOperations "$dest;install" --InstanceId $id | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Finalizer failed for $id ($LASTEXITCODE)." }
    Write-Host "  installed $version" -ForegroundColor Green

    # The check that matters: this extension hive-scoped, and nowhere install-scoped.
    $hive = (Get-ChildItem $root -Directory -ErrorAction SilentlyContinue).Name -join ', '
    $shadow = @(Get-InstallScopedCopy $instance.installationPath $extensionId)

    Write-Host "  hive-scoped   : $hive"
    Write-Host "  install-scoped: $(if ($shadow) { "$($shadow.Name -join ', ')  <-- SHADOWS F5, REMOVE IT" } else { '(none)' })"
}

Write-Host "`nDone. Restart Visual Studio to pick it up." -ForegroundColor Cyan
