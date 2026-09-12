[CmdletBinding()]
param([switch] $Restart, [switch] $SkipDatabase)
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectPath
if (-not (Test-Path -LiteralPath '.env')) {
  & npm.cmd run setup
  if ($LASTEXITCODE -ne 0) { throw '本機設定尚未完成。' }
}
# Share the same ownership-checked process metadata with the background launcher.
& (Join-Path $PSScriptRoot 'start-services.ps1') -IncludeWeb -NoTunnel -Restart:$Restart -SkipDatabase:$SkipDatabase
