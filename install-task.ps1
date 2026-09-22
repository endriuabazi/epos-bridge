# install-task.ps1
#
# Registers the bridge as a Windows scheduled task so it starts at boot,
# with no terminal window and without anyone logging in.
#
# Run in PowerShell AS ADMINISTRATOR (creating a task that runs as SYSTEM
# requires it):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-task.ps1
#
# Remove it again with:  .\install-task.ps1 -Uninstall

param(
  [string]$TaskName = "epos-bridge",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal] `
      [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "This script must run as Administrator." -ForegroundColor Red
  exit 1
}

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  } else {
    Write-Host "No scheduled task named '$TaskName'." -ForegroundColor Yellow
  }
  exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host "node.exe is not on PATH. Install Node.js first." -ForegroundColor Red
  exit 1
}

$workDir = $PSScriptRoot
$script  = Join-Path $workDir "server.js"
if (-not (Test-Path $script)) {
  Write-Host "server.js not found next to this script." -ForegroundColor Red
  exit 1
}

Write-Host "`nRegistering '$TaskName' ..." -ForegroundColor Cyan
Write-Host "  node       : $node"
Write-Host "  server.js  : $script"

# Replace any previous version of the task.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "  (replaced the existing task)" -ForegroundColor DarkGray
}

$action = New-ScheduledTaskAction -Execute $node -Argument "server.js" -WorkingDirectory $workDir

# At boot, so it does not depend on anyone logging in.
$trigger = New-ScheduledTaskTrigger -AtStartup

# SYSTEM: runs with no desktop session and may bind port 443.
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# The battery settings matter on a laptop: without them Windows refuses to
# start the task, or kills it, when running unplugged.
# ExecutionTimeLimit 0 means "never time out" - the default stops it after 3 days.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName `
  -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description "epos-bridge: translates Odoo ePOS-Print to raw ESC/POS on TCP 9100" | Out-Null

Write-Host "  registered." -ForegroundColor Green

Write-Host "`nStarting it now ..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host "  state: $state"

Write-Host "`nDone." -ForegroundColor Green
Write-Host ""
Write-Host "  Check it:   Get-ScheduledTask -TaskName $TaskName"
Write-Host "  Stop it:    Stop-ScheduledTask -TaskName $TaskName"
Write-Host "  Remove it:  .\install-task.ps1 -Uninstall"
Write-Host ""
