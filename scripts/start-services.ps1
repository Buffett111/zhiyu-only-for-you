[CmdletBinding()]
param([switch] $Restart, [switch] $RestartApi, [switch] $IncludeWeb, [switch] $NoTunnel, [switch] $SkipDatabase)
$ErrorActionPreference = 'Stop'
$projectPath = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
Set-Location -LiteralPath $projectPath
if (-not (Test-Path -LiteralPath '.env')) { throw '請先執行 npm run setup 並完成 .env 設定。' }
if (-not $IncludeWeb -and -not (Test-Path -LiteralPath 'dist/index.html')) { throw '請先執行 npm run build。' }
if (-not $SkipDatabase) {
  & docker compose up -d --wait db
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL 尚未就緒，請確認 Docker Desktop。' }
  & npm.cmd run db:migrate
  if ($LASTEXITCODE -ne 0) { throw '資料庫遷移失敗，已停止啟動。' }
}
New-Item -ItemType Directory -Force -Path (Join-Path $projectPath '.cache') | Out-Null

function Get-ZhiyuProcess([int] $serviceProcessId) {
  Get-CimInstance Win32_Process -Filter "ProcessId = $serviceProcessId" -ErrorAction Stop
}
function Get-ProcessStamp($serviceProcess) { $serviceProcess.CreationDate.ToUniversalTime().ToString('O') }
function Test-ProjectProcess($serviceProcess, [string] $executable, [string] $entryPoint, $savedState) {
  if (-not $serviceProcess -or $serviceProcess.ExecutablePath -ne $executable) { return $false }
  $commandLine = [string] $serviceProcess.CommandLine
  if ($entryPoint -eq 'tunnel') {
    $tokenPath = Join-Path $projectPath '.cache/zhiyu-tunnel-token.txt'
    if ($commandLine.Contains($tokenPath)) { return $true }
    # Legacy relative token paths are trusted only with matching saved PID and creation time.
    return ($savedState -and $savedState.processId -eq $serviceProcess.ProcessId -and
      $savedState.startedAt -eq (Get-ProcessStamp $serviceProcess) -and
      $commandLine -match '--token-file\s+"?\.cache[\\/]zhiyu-tunnel-token\.txt')
  }
  if ($commandLine -match '(?:^|\s)--once(?:\s|$)') { return $false }
  $absoluteEntry = Join-Path $projectPath $entryPoint
  if ($commandLine.Contains($absoluteEntry) -or $commandLine.Contains($absoluteEntry.Replace('\', '/'))) { return $true }
  # Existing npm/tsx children include an absolute workspace-specific loader path.
  $hasWorkspace = $commandLine.Contains($projectPath) -or $commandLine.Contains($projectPath.Replace('\', '/'))
  $relativeEntry = [Regex]::Escape($entryPoint).Replace('/', '[\\/]')
  return ($hasWorkspace -and $commandLine -match ('(?:^|\s|")' + $relativeEntry + '(?:\s|"|$)'))
}
function Save-ProcessState([string] $statePath, $serviceProcess, [string] $executable, [string] $entryPoint) {
  [ordered]@{ processId = [int] $serviceProcess.ProcessId; startedAt = Get-ProcessStamp $serviceProcess
    executable = $executable; projectPath = $projectPath; entryPoint = $entryPoint
  } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
}
function Stop-ProjectProcess($serviceProcess, [string] $executable, [string] $entryPoint, $savedState) {
  $freshProcess = Get-ZhiyuProcess ([int] $serviceProcess.ProcessId)
  if (-not $freshProcess) { return }
  if ((Get-ProcessStamp $freshProcess) -ne (Get-ProcessStamp $serviceProcess) -or
      -not (Test-ProjectProcess $freshProcess $executable $entryPoint $savedState)) { throw '程序身分已變更，已取消停止動作。' }
  $result = Invoke-CimMethod -InputObject $freshProcess -MethodName Terminate -Arguments @{ Reason = [uint32] 0 }
  if ($result.ReturnValue -ne 0) { throw "無法停止知隅程序，系統代碼 $($result.ReturnValue)。" }
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if (-not (Get-ZhiyuProcess ([int] $freshProcess.ProcessId))) { return }
    Start-Sleep -Milliseconds 250
  }
  throw '知隅程序尚未停止，已取消重新啟動以避免重複執行。'
}
function Get-Listener([int] $listenPort) {
  @(Get-NetTCPConnection -State Listen -LocalPort $listenPort -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
}
function Wait-Ready([string] $serviceName, $serviceProcess, [int] $listenPort, [string] $logPath) {
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (-not (Get-ZhiyuProcess ([int] $serviceProcess.ProcessId))) { throw "$serviceName 啟動失敗，請查看 .cache/$serviceName-error.log。" }
    if ($serviceName -eq 'api') {
      try { $response = Invoke-RestMethod -Uri "http://127.0.0.1:$listenPort/api/health" -TimeoutSec 2; if ($response.status -eq 'ok') { return } } catch { }
    } elseif ($serviceName -eq 'worker') {
      if ((Test-Path -LiteralPath $logPath) -and (Select-String -LiteralPath $logPath -Pattern '"event":"worker-ready"' -Quiet)) { return }
    } elseif ((Get-Listener $listenPort) -contains [int] $serviceProcess.ProcessId) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "$serviceName 尚未通過啟動檢查，請查看 .cache 的執行紀錄。"
}
function Start-ZhiyuService([string] $serviceName, [string] $executable, [string[]] $serviceArguments, [string] $entryPoint, [int] $listenPort = 0) {
  $statePath = Join-Path $projectPath ".cache/$serviceName-process.json"
  $savedState = $null
  if (Test-Path -LiteralPath $statePath) { try { $savedState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { } }
  $candidate = $null
  if ($savedState -and $savedState.processId) {
    $savedProcess = Get-ZhiyuProcess ([int] $savedState.processId)
    if ($savedProcess -and $savedState.startedAt -eq (Get-ProcessStamp $savedProcess) -and
        (Test-ProjectProcess $savedProcess $executable $entryPoint $savedState)) { $candidate = $savedProcess }
  }
  if ($listenPort) {
    foreach ($ownerId in @(Get-Listener $listenPort)) {
      $ownerProcess = Get-ZhiyuProcess ([int] $ownerId)
      if (-not (Test-ProjectProcess $ownerProcess $executable $entryPoint $savedState)) { throw "$listenPort 由非此專案的程序使用；已保留該程序並停止啟動。" }
      $candidate = $ownerProcess
    }
  } elseif (-not $candidate) {
    $matchingProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { Test-ProjectProcess $_ $executable $entryPoint $savedState })
    $parentIds = @($matchingProcesses | Select-Object -ExpandProperty ParentProcessId)
    $matchingProcesses = @($matchingProcesses | Where-Object { $parentIds -notcontains $_.ProcessId })
    if ($matchingProcesses.Count -gt 1) { throw "發現多個此專案的 $serviceName 程序，已停止啟動以免增加重複工作。" }
    if ($matchingProcesses.Count -eq 1) { $candidate = $matchingProcesses[0] }
  }
  if ($candidate -and ($Restart -or ($RestartApi -and $serviceName -eq 'api'))) {
    Stop-ProjectProcess $candidate $executable $entryPoint $savedState
    $candidate = $null
  }
  $logPath = Join-Path $projectPath ".cache/$serviceName.log"
  if ($candidate) {
    Save-ProcessState $statePath $candidate $executable $entryPoint
    if ($serviceName -eq 'api') { Wait-Ready $serviceName $candidate $listenPort $logPath }
    Write-Host "$serviceName 已在執行（PID $($candidate.ProcessId)）。"
    return
  }
  $quotedArguments = @($serviceArguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })
  $launched = Start-Process -FilePath $executable -ArgumentList $quotedArguments -WorkingDirectory $projectPath -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError (Join-Path $projectPath ".cache/$serviceName-error.log") -PassThru
  $startedProcess = Get-ZhiyuProcess ([int] $launched.Id)
  if (-not $startedProcess) { throw "$serviceName 無法啟動，請查看 .cache/$serviceName-error.log。" }
  Save-ProcessState $statePath $startedProcess $executable $entryPoint
  Wait-Ready $serviceName $startedProcess $listenPort $logPath
  Write-Host "$serviceName 已啟動（PID $($startedProcess.ProcessId)）。"
}

$nodeExecutable = (Get-Command node.exe).Source
$apiPort = 3001
$configuredPort = Select-String -LiteralPath '.env' -Pattern '^PORT=(\d+)\s*$' | Select-Object -Last 1
if ($configuredPort) { $apiPort = [int] $configuredPort.Matches[0].Groups[1].Value }
$envFile = Join-Path $projectPath '.env'
$tsxLoader = (New-Object System.Uri((Join-Path $projectPath 'node_modules/tsx/dist/loader.mjs'))).AbsoluteUri
Start-ZhiyuService 'api' $nodeExecutable @('--use-system-ca','--import',$tsxLoader,"--env-file=$envFile",(Join-Path $projectPath 'server/main.ts')) 'server/main.ts' $apiPort
Start-ZhiyuService 'worker' $nodeExecutable @('--use-system-ca','--import',$tsxLoader,"--env-file=$envFile",(Join-Path $projectPath 'server/worker.ts')) 'server/worker.ts'
if ($IncludeWeb) { Start-ZhiyuService 'web' $nodeExecutable @((Join-Path $projectPath 'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--strictPort') 'node_modules/vite/bin/vite.js' 5173 }
if (-not $NoTunnel -and (Test-Path -LiteralPath '.cache/zhiyu-tunnel-token.txt')) {
  $cloudflaredExecutable = (Get-Command cloudflared.exe).Source
  Start-ZhiyuService 'tunnel' $cloudflaredExecutable @('tunnel','--no-autoupdate','--loglevel','warn','--metrics','127.0.0.1:20246','run','--token-file',(Join-Path $projectPath '.cache/zhiyu-tunnel-token.txt')) 'tunnel' 20246
}
if ($IncludeWeb) { Write-Host '知隅本機預覽：http://127.0.0.1:5173' }
else { Write-Host "知隅本機預覽：http://127.0.0.1:$apiPort" }
Write-Host '服務已在背景執行，紀錄位於 .cache。重複執行不會建立重複程序；程式更新後可加上 -Restart。'
