# Starts everything needed for a phone test on Windows, in the right order:
#   two cloudflared quick tunnels -> env files pointed at them -> server + web dev servers.
# Quick-tunnel URLs change on every run, which is why the env rewrite has to be scripted.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\phone-test.ps1
# Stop:   close the three windows it opens (2x cloudflared, server, web) or Ctrl+C each.

$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent

$serverPort = 8787   # 8080 is taken by llama-server on this machine
$webPort = 3000

function Find-Exe($name, $fallbacks) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in $fallbacks) { if (Test-Path $p) { return $p } }
  throw "$name not found. Install it and re-run."
}

$bun = Find-Exe "bun" @(
  "$env:USERPROFILE\.bun\bin\bun.exe",
  "C:\Users\frank\AppData\Local\Microsoft\WinGet\Packages\Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe\bun-windows-x64\bun.exe"
)
$cloudflared = Find-Exe "cloudflared" @("C:\Program Files (x86)\cloudflared\cloudflared.exe")

# --- 1. tunnels (cloudflared logs the URL to stderr) -------------------------
$logDir = Join-Path $repo ".tunnels"
New-Item -ItemType Directory -Force $logDir | Out-Null
$serverLog = Join-Path $logDir "server-tunnel.log"
$webLog = Join-Path $logDir "web-tunnel.log"
Remove-Item $serverLog, $webLog -ErrorAction SilentlyContinue

Start-Process $cloudflared -ArgumentList "tunnel", "--url", "http://localhost:$serverPort" -RedirectStandardError $serverLog -WindowStyle Minimized
Start-Process $cloudflared -ArgumentList "tunnel", "--url", "http://localhost:$webPort" -RedirectStandardError $webLog -WindowStyle Minimized

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
@"
NEXT_PUBLIC_API_URL=$serverUrl
NEXT_PUBLIC_WS_URL=$($serverUrl -replace '^https', 'wss')/ws
"@ | Out-File -Encoding utf8 (Join-Path $repo "apps\web\.env.local")

@"
PORT=$serverPort
ROOM_FIXED_CODE=BZQ7
NEXT_PUBLIC_WEB_URL=$webUrl
ANTHROPIC_API_KEY=
"@ | Out-File -Encoding utf8 (Join-Path $repo "apps\server\.env")

# --- 3. dev servers -----------------------------------------------------------
Start-Process $bun -ArgumentList "run", "--cwd", (Join-Path $repo "apps\server"), "dev"
Start-Process $bun -ArgumentList "run", "--cwd", (Join-Path $repo "apps\web"), "dev"

Start-Sleep -Seconds 6
Write-Host ""
Write-Host "=== HiveMusic phone test ready ==="
Write-Host "Host page (open this, it shows the QR):  $webUrl/h/BZQ7"
Write-Host "Phones join at:                          $webUrl/j/BZQ7"
Write-Host "Diagnostics per device:                  $webUrl/diag"
