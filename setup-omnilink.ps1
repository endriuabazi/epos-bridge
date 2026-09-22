# setup-omnilink.ps1
#
# Sets this machine up to answer on the hostname Odoo derives from a "serial
# number", so recent Odoo versions can print to the bridge.
#
# Elevation is needed for ONE thing only: writing the Windows hosts file.
# The certificate goes into your user's store, which needs no admin rights.
#
# Run in PowerShell AS ADMINISTRATOR:
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   .\setup-omnilink.ps1 -Serial FRUTZA-KUZHINA

param(
  [string]$Serial = "FRUTZA-KUZHINA",
  [int]$Port = 8043,
  [string]$Passphrase = "epos"
)

$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal] `
      [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "This script must run as Administrator." -ForegroundColor Red
  Write-Host "Only the hosts-file entry needs it; everything else is user-scoped."
  exit 1
}

# --- 1. Work out the hostname Odoo will use -------------------------------

Write-Host "`nDeriving the hostname Odoo will use for serial '$Serial' ..." -ForegroundColor Cyan

$domain = & node (Join-Path $PSScriptRoot "epson-domain.js") $Serial |
  Select-String "hostname Odoo will use" |
  ForEach-Object { ($_ -split ":")[1].Trim() }

if (-not $domain) {
  Write-Host "Could not derive the hostname. Is Node installed and on PATH?" -ForegroundColor Red
  exit 1
}

Write-Host "  $domain"

# --- 2. Point that hostname at this machine -------------------------------

$hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
$entry = "127.0.0.1`t$domain"

Write-Host "`nAdding it to the hosts file ..." -ForegroundColor Cyan
$existing = Get-Content $hostsPath -ErrorAction SilentlyContinue

if ($existing -match [regex]::Escape($domain)) {
  Write-Host "  already present, leaving it alone"
} else {
  Add-Content -Path $hostsPath -Value "`r`n# epos-bridge ($Serial)`r`n$entry"
  Write-Host "  added: $entry"
}

ipconfig /flushdns | Out-Null

# --- 3. Certificate for that hostname -------------------------------------

Write-Host "`nCreating a certificate for $domain ..." -ForegroundColor Cyan

# Clear out certificates from earlier runs so they don't stack up.
foreach ($loc in @("CurrentUser", "LocalMachine")) {
  foreach ($storeName in @("My", "Root")) {
    $stale = Get-ChildItem "Cert:\$loc\$storeName" -ErrorAction SilentlyContinue |
      Where-Object { $_.FriendlyName -like "epos-bridge*" -or $_.Subject -eq "CN=$domain" }
    foreach ($old in $stale) {
      Remove-Item "Cert:\$loc\$storeName\$($old.Thumbprint)" -Force -ErrorAction SilentlyContinue
      Write-Host "  removed old certificate $($old.Thumbprint) from $loc\$storeName" -ForegroundColor DarkGray
    }
  }
}

# Create it in the USER store. The machine store needs rights that policy may
# withhold even from an administrator.
$cert = New-SelfSignedCertificate `
  -Subject "CN=$domain" `
  -DnsName $domain, "localhost" `
  -KeyExportPolicy Exportable `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -KeyAlgorithm RSA -KeyLength 2048 `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -NotAfter (Get-Date).AddYears(10) `
  -FriendlyName "epos-bridge ($Serial)"

Write-Host "  thumbprint: $($cert.Thumbprint)"

Write-Host "`nTrusting it for your user account ..." -ForegroundColor Cyan
Write-Host "  Windows may ask you to confirm. Answer YES." -ForegroundColor Yellow

$store = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "CurrentUser")
$store.Open("ReadWrite")
$store.Add($cert)
$store.Close()

if (-not (Test-Path "Cert:\CurrentUser\Root\$($cert.Thumbprint)")) {
  Write-Host "`nThe certificate was NOT added to your trusted roots." -ForegroundColor Red
  Write-Host "If you dismissed the confirmation dialog, run this script again."
  exit 1
}
Write-Host "  trusted (current user)." -ForegroundColor Green

# Machine-wide trust is a bonus, not a requirement. Policy often blocks it.
try {
  $m = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "LocalMachine")
  $m.Open("ReadWrite")
  $m.Add($cert)
  $m.Close()
  Write-Host "  trusted (machine-wide too)." -ForegroundColor Green
} catch {
  Write-Host "  machine-wide trust refused by policy - not needed, continuing." -ForegroundColor DarkGray
}

$certDir = Join-Path $PSScriptRoot "certs"
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
$pfxPath = Join-Path $certDir "bridge.pfx"
Export-PfxCertificate -Cert $cert -FilePath $pfxPath `
  -Password (ConvertTo-SecureString -String $Passphrase -Force -AsPlainText) | Out-Null
Write-Host "  exported: $pfxPath"

# --- 4. Point the bridge's config at it -----------------------------------

$configPath = Join-Path $PSScriptRoot "config.json"
$cfg = Get-Content $configPath -Raw | ConvertFrom-Json
$cfg | Add-Member -NotePropertyName listenPort -NotePropertyValue $Port -Force
$cfg.tls | Add-Member -NotePropertyName enabled    -NotePropertyValue $true              -Force
$cfg.tls | Add-Member -NotePropertyName pfxFile    -NotePropertyValue "certs/bridge.pfx" -Force
$cfg.tls | Add-Member -NotePropertyName passphrase -NotePropertyValue $Passphrase        -Force
[System.IO.File]::WriteAllText($configPath, ($cfg | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  config.json updated (listenPort = $Port, tls enabled)"

# --- 5. What to do next ---------------------------------------------------

Write-Host "`nDone." -ForegroundColor Green
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Restart the bridge:  node server.js"
Write-Host "     It must say:         listening https://0.0.0.0:$Port"
Write-Host ""
Write-Host "  2. Open this once in the browser you use for Odoo:"
Write-Host "       https://${domain}:${Port}/health" -ForegroundColor Yellow
Write-Host "     You want {`"ok`":true,...} with no certificate warning."
Write-Host ""
Write-Host "  3. In Odoo, Kuzhina -> Epson Printer IP Address, type exactly:"
Write-Host "       $Serial" -ForegroundColor Yellow
Write-Host "     Click outside the field. Odoo should show the same hostname"
Write-Host "     printed above. Save, reopen the POS session, then Test."
Write-Host ""
