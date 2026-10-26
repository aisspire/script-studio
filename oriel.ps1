[CmdletBinding()]
param([string]$DataDir = '')
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$exe = Join-Path $PSScriptRoot 'script-studio.exe'
if (-not (Test-Path $exe)) { $exe = Join-Path $PSScriptRoot 'target/windows/release/script-studio.exe' }
if (-not (Test-Path $exe)) { $exe = Join-Path $PSScriptRoot 'target/windows/debug/script-studio.exe' }
if (-not (Test-Path $exe)) { throw 'Script Studio executable missing. Build the Windows directory bundle first.' }
$arguments = @('serve', '--oriel-stdio')
if ($DataDir) { $arguments += @('--data-dir', $DataDir) }
& $exe @arguments
exit $LASTEXITCODE
