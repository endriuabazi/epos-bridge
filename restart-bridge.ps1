# restart-bridge.ps1
#
# Restarts the epos-bridge scheduled task and waits until it answers again.
# Asks for administrator rights by itself (the task runs as SYSTEM).
#
#   .\restart-bridge.ps1                   # restart
#   .\restart-bridge.ps1 -CreateShortcuts  # put "Restart printer bridge" and
#                                          # "Printer bridge status" on the desktop

param(
  [string]$TaskName = "epos-bridge",
  [switch]$CreateShortcuts
)

$ErrorActionPreference = "Stop"

$configPath = Join-Path $PSScriptRoot "config.json"
$logPath    = Join-Path $PSScriptRoot "logs\bridge.log"

# Where the bridge listens, so the status link and health check use the right URL.
$port = 8080
$scheme = "http"
if (Test-Path $configPath) {
  $cfg = (Get-Content $configPath -Raw) -replace "^﻿", "" | ConvertFrom-Json
  if ($cfg.listenPort) { $port = [int]$cfg.listenPort }
  if ($cfg.tls -and $cfg.tls.enabled) { $scheme = "https" }
}
$defaultPort = if ($scheme -eq "https") { 443 } else { 80 }
$baseUrl = if ($port -eq $defaultPort) { "${scheme}://localhost" } else { "${scheme}://localhost:$port" }

if ($CreateShortcuts) {
  $desktop = [Environment]::GetFolderPath("Desktop")
  $shell = New-Object -ComObject WScript.Shell

  $lnk = $shell.CreateShortcut((Join-Path $desktop "Restart printer bridge.lnk"))
  $lnk.TargetPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $lnk.WorkingDirectory = $PSScriptRoot
  $lnk.Description = "Restart the epos-bridge printer bridge"
  $lnk.Save()

  Set-Content -Path (Join-Path $desktop "Printer bridge status.url") -Encoding ASCII `
    -Value "[InternetShortcut]`r`nURL=$baseUrl/"

  Write-Host "Created on your desktop:" -ForegroundColor Green
  Write-Host "  Restart printer bridge"
  Write-Host "  Printer bridge status  ($baseUrl/)"
  exit 0
}

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  # Re-launch this script elevated; Windows shows the usual Yes/No prompt.
  Start-Process powershell.exe -Verb RunAs `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  exit 0
}

function Get-StartCount {
  if (-not (Test-Path $logPath)) { return 0 }
  return @(Select-String -Path $logPath -Pattern " started: " -SimpleMatch).Count
}

Write-Host "`nRestarting the printer bridge ..." -ForegroundColor Cyan

if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
  Write-Host "There is no scheduled task called '$TaskName'." -ForegroundColor Red
  Write-Host "Install it first:  powershell -NoProfile -ExecutionPolicy Bypass -File .\install-task.ps1"
  Read-Host "`nPress Enter to close"
  exit 1
}

$before = Get-StartCount
Stop-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName $TaskName

# Done when the log shows a new start and /health answers.
$ok = $false
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 1
  if ((Get-StartCount) -le $before) { continue }
  $health = & curl.exe -k -s --max-time 2 "$baseUrl/health" 2>$null
  if ($health -match '"ok":true') { $ok = $true; break }
}

if ($ok) {
  Write-Host "Bridge restarted OK. $baseUrl/" -ForegroundColor Green
} else {
  Write-Host "The bridge did not come back within 15 seconds." -ForegroundColor Red
  Write-Host "Task state: $((Get-ScheduledTask -TaskName $TaskName).State)"
  if (Test-Path $logPath) {
    Write-Host "`nLast lines of logs\bridge.log:"
    Get-Content $logPath -Tail 5
  }
}

Read-Host "`nPress Enter to close"
