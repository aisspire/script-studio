[CmdletBinding()]
param([switch]$SkipFrontend, [switch]$Offline, [switch]$DebugBuild)
$ErrorActionPreference = 'Stop'
$originalLocation = Get-Location
$originalTarget = $env:CARGO_TARGET_DIR
try {
    Set-Location $PSScriptRoot
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'Missing Windows Rust toolchain. No tools were installed.' }
    if (-not $SkipFrontend) {
        if (-not (Test-Path 'node_modules/vue')) { throw 'Install this repository Windows dependencies with npm ci --include=optional first, or provide a freshly built dist with -SkipFrontend.' }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    }
    if (-not (Test-Path 'dist/index.html')) { throw 'Missing frontend dist/index.html.' }
    $env:CARGO_TARGET_DIR = Join-Path $PSScriptRoot 'target/windows'
    $arguments = @('build', '--locked')
    $profile = 'debug'
    if (-not $DebugBuild) { $arguments += '--release'; $profile = 'release' }
    if ($Offline) { $arguments += '--offline' }
    & cargo @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Rust build failed.' }
    $bundle = Join-Path $PSScriptRoot 'release/ScriptStudio-0.1.0-windows'
    if (Test-Path $bundle) { Remove-Item -Recurse -Force $bundle }
    New-Item -ItemType Directory -Path $bundle -Force | Out-Null
    Copy-Item "target/windows/$profile/script-studio.exe" $bundle
    Copy-Item 'plugin.json','oriel.ps1','USER_GUIDE.md','Open-ScriptStudio.cmd' $bundle
    Copy-Item -Recurse 'dist' $bundle
    Write-Output "Bundle: $bundle"
} finally {
    $env:CARGO_TARGET_DIR = $originalTarget
    Set-Location $originalLocation
}
