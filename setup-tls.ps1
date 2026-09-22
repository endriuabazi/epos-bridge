# setup-tls.ps1
# Creates a self-signed certificate for this machine, trusts it for the current
# user, and exports a .pfx that server.js can use directly.
#
# Run in a NORMAL PowerShell window — no Administrator rights needed:
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   .\setup-tls.ps1
#
# Windows will show one consent dialog when the certificate is trusted.
# Answer Yes, or the browser will still refuse the bridge.
#
# Optional: .\setup-tls.ps1 -IpAddress 192.168.3.25

param(
  [string]$IpAddress = "",
  [string]$Passphrase = "epos"
)

$ErrorActionPreference = "Stop"

# Work out which IP to certify: the address Odoo will connect to.
if (-not $IpAddress) {
  $candidates = @(Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*" -and
      $_.PrefixOrigin -ne "WellKnown"
    })

  if (-not $candidates) { Write-Host "No usable IPv4 address found." -ForegroundColor Red; exit 1 }

  if ($candidates.Count -gt 1) {
    Write-Host "`nWhich address will Odoo use to reach this machine?`n"
    $i = 1
    foreach ($c in $candidates) {
      $alias = (Get-NetAdapter -InterfaceIndex $c.InterfaceIndex).Name
      Write-Host "  [$i] $($c.IPAddress)   ($alias)"
      $i++
    }
    Write-Host ""
    $pick = Read-Host "Number"
    $IpAddress = $candidates[[int]$pick - 1].IPAddress
  } else {
    $IpAddress = $candidates[0].IPAddress
  }
}

# Clear out certificates left by earlier runs, so repeating this doesn't stack
# up duplicate roots (and duplicate consent dialogs).
foreach ($storeName in @("My", "Root")) {
  $stale = Get-ChildItem "Cert:\CurrentUser\$storeName" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.FriendlyName -like "epos-bridge*" -or
      ($_.Subject -eq "CN=$IpAddress" -and $_.Issuer -eq $_.Subject)
    }
  foreach ($old in $stale) {
    Remove-Item "Cert:\CurrentUser\$storeName\$($old.Thumbprint)" -Force -ErrorAction SilentlyContinue
    Write-Host "  removed old certificate $($old.Thumbprint) from $storeName" -ForegroundColor DarkGray
  }
}

Write-Host "`nCreating a certificate for $IpAddress ..." -ForegroundColor Cyan

# The SAN covers localhost and 127.0.0.1 as well as the LAN address, so Odoo
# works whether it is pointed at the IP or at localhost.
$cert = New-SelfSignedCertificate `
  -Subject "CN=$IpAddress" `
  -TextExtension @("2.5.29.17={text}IPAddress=$IpAddress&DNS=$IpAddress&DNS=localhost&IPAddress=127.0.0.1") `
  -KeyExportPolicy Exportable `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -KeyAlgorithm RSA -KeyLength 2048 `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -NotAfter (Get-Date).AddYears(10) `
  -FriendlyName "epos-bridge ($IpAddress)"

Write-Host "  thumbprint: $($cert.Thumbprint)"

# Trust it for this user, so the browser stops warning about it. The machine
# store would need Administrator; the user store does not, and Chrome and Edge
# read both.
Write-Host "`nAdding it to your Trusted Root Certification Authorities ..." -ForegroundColor Cyan
Write-Host "  Windows will now ask you to confirm. Answer YES." -ForegroundColor Yellow
Write-Host "  (Say no and the certificate exists but nothing trusts it.)" -ForegroundColor DarkGray

$root = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "CurrentUser")
$root.Open("ReadWrite")
$root.Add($cert)
$root.Close()

if (-not (Test-Path "Cert:\CurrentUser\Root\$($cert.Thumbprint)")) {
  Write-Host "`nThe certificate was NOT added to your trusted roots." -ForegroundColor Red
  Write-Host "If you dismissed the confirmation dialog, run this script again."
  exit 1
}
Write-Host "  trusted." -ForegroundColor Green

# Export a PFX that Node can load without OpenSSL.
$certDir = Join-Path $PSScriptRoot "certs"
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
$pfxPath = Join-Path $certDir "bridge.pfx"

$securePass = ConvertTo-SecureString -String $Passphrase -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePass | Out-Null
Write-Host "  exported: $pfxPath"

# Patch config.json so server.js picks it up. Add-Member -Force is required:
# tls may not have pfxFile/passphrase yet, and assigning an absent property on
# a ConvertFrom-Json object throws.
$configPath = Join-Path $PSScriptRoot "config.json"
$cfg = $null
if (Test-Path $configPath) {
  $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
  $cfg.tls | Add-Member -NotePropertyName enabled    -NotePropertyValue $true              -Force
  $cfg.tls | Add-Member -NotePropertyName pfxFile    -NotePropertyValue "certs/bridge.pfx" -Force
  $cfg.tls | Add-Member -NotePropertyName passphrase -NotePropertyValue $Passphrase        -Force
  [System.IO.File]::WriteAllText($configPath, ($cfg | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "  config.json updated (tls.enabled = true)"
} else {
  Write-Host "  config.json not found — set tls.enabled/pfxFile/passphrase by hand." -ForegroundColor Yellow
}

$port = if ($cfg) { $cfg.listenPort } else { 8080 }

Write-Host "`nDone." -ForegroundColor Green
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Restart the bridge:   node server.js"
Write-Host "     It must now say:      listening https://..." -ForegroundColor Yellow
Write-Host "  2. Open this once in the SAME browser you use for Odoo:"
Write-Host "       https://localhost:${port}" -ForegroundColor Yellow
Write-Host "     It should load with no warning. If it does warn,"
Write-Host "     click Advanced then Proceed."
Write-Host "  3. In Odoo set the Epson Printer IP Address to:"
Write-Host "       localhost:${port}   (or ${IpAddress}:${port})" -ForegroundColor Yellow
Write-Host "  4. Save, close and reopen the POS session, then click Test."
Write-Host ""
