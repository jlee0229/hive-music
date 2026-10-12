# Test UNRELEASED code on real phones without touching production (Windows).
#
# Production (playhivemusic.com) is where finished work goes, and deploying the server there ends
# every running party. This script is for everything before that: it puts the dev servers on this
# machine behind two throwaway HTTPS tunnels so phones on any network can join a hive that runs
# your working tree.
#
#   two cloudflared quick tunnels -> env files pointed at them -> server + web dev servers
#
# Quick-tunnel URLs change on every run, which is why the env rewrite has to be scripted.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\phone-test.ps1 [-ServerPort 8787] [-WebPort 3000]
# Stop:   close the four windows it opens (2x cloudflared, server, web), or Ctrl+C each.
# Needs:  bun and cloudflared   (winget install Oven-sh.Bun Cloudflare.cloudflared)
#
# It OVERWRITES apps\web\.env.local and apps\server\.env. A file it did not write itself is
# copied to <name>.before-phone-test first; restore or delete the env files afterwards if you
# normally develop against other settings (with no env files at all, everything defaults to
# localhost:8080 / localhost:3000).
param(
  [int]$ServerPort = 8787,   # not 8080: that port is commonly taken on a dev machine
  [int]$WebPort = 3000
)

$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$marker = "# written by scripts/phone-test.ps1 (safe to delete)"

function Find-Exe($name, $fallbacks) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in $fallbacks) {
    $hit = Get-Item $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  throw "$name not found. Install it (winget install Oven-sh.Bun Cloudflare.cloudflared), open a new terminal and re-run."
}

$bunFallbacks = @(
  "$env:USERPROFILE\.bun\bin\bun.exe",
  "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Oven-sh.Bun_*\bun-windows-x64\bun.exe"
)
if ($env:BUN_BIN) { $bunFallbacks = @($env:BUN_BIN) + $bunFallbacks }
$bun = Find-Exe "bun" $bunFallbacks
$cloudflared = Find-Exe "cloudflared" @(
  "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
  "$env:ProgramFiles\cloudflared\cloudflared.exe"
)

foreach ($port in @($ServerPort, $WebPort)) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $port is already in use. Stop whatever is listening there, or pass -ServerPort / -WebPort."
  }
}

# --- 1. tunnels (cloudflared logs the URL to stderr) -------------------------
$logDir = Join-Path $repo ".tunnels"
New-Item -ItemType Directory -Force $logDir | Out-Null
$serverLog = Join-Path $logDir "server-tunnel.log"
$webLog = Join-Path $logDir "web-tunnel.log"
Remove-Item $serverLog, $webLog -ErrorAction SilentlyContinue

Start-Process $cloudflared -ArgumentList "tunnel", "--url", "http://localhost:$ServerPort" -RedirectStandardError $serverLog -WindowStyle Minimized
Start-Process $cloudflared -ArgumentList "tunnel", "--url", "http://localhost:$WebPort" -RedirectStandardError $webLog -WindowStyle Minimized

function Wait-TunnelUrl($log) {
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    $text = Get-Content $log -Raw -ErrorAction SilentlyContinue
    if ($text -match "https://[a-z0-9-]+\.trycloudflare\.com") { return $Matches[0] }
  }
  throw "No tunnel URL appeared in $log after 30s"
}

$serverUrl = Wait-TunnelUrl $serverLog
$webUrl = Wait-TunnelUrl $webLog
Write-Host "server tunnel: $serverUrl"
Write-Host "web tunnel:    $webUrl"

# --- 2. env files (NEXT_PUBLIC_* is baked in at dev-server start) ------------
function Write-EnvFile($path, $lines) {
  if ((Test-Path $path) -and -not ((Get-Content $path -Raw) -like "*$marker*")) {
    Copy-Item $path "$path.before-phone-test" -Force
    Write-Host "kept your existing $(Split-Path $path -Leaf) as $(Split-Path $path -Leaf).before-phone-test"
  }
  # The marker comment goes first so the UTF-8 BOM that Windows PowerShell 5.1 writes lands on a
  # comment line, not on the first variable name.
  (@($marker) + $lines) -join "`n" | Out-File -Encoding utf8 $path
}

Write-EnvFile (Join-Path $repo "apps\web\.env.local") @(
  "NEXT_PUBLIC_API_URL=$serverUrl",
  "NEXT_PUBLIC_WS_URL=$($serverUrl -replace '^https', 'wss')/ws"
)

# No ROOM_FIXED_CODE: like production, every hive gets a random code.
Write-EnvFile (Join-Path $repo "apps\server\.env") @(
  "PORT=$ServerPort",
  "NEXT_PUBLIC_WEB_URL=$webUrl"
)

# --- 3. dev servers -----------------------------------------------------------
Start-Process $bun -ArgumentList "run", "--cwd", (Join-Path $repo "apps\server"), "dev"
# `next dev` directly rather than the package script, which hardcodes port 3000.
Start-Process $bun -ArgumentList "x", "next", "dev", "-p", "$WebPort" -WorkingDirectory (Join-Path $repo "apps\web")

Start-Sleep -Seconds 6
Write-Host ""
Write-Host "=== HiveMusic phone test ready ==="
Write-Host "On the host phone open:    $webUrl      then tap 'Host a hive'"
Write-Host "Guests scan the QR the host screen shows (it points at $webUrl/j/<code>)."
Write-Host "Diagnostics per device:    $webUrl/diag"
Write-Host ""
Write-Host "These URLs are public while the tunnels run: anyone holding them reaches this machine's"
Write-Host "dev servers. Close the cloudflared windows when you are done."
