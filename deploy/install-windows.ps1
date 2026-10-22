#Requires -Version 5.1
<#
  ClipForge Windows installer — installs everything itself:
  WSL 2, Docker Desktop, Git, Tailscale (via winget), then builds and starts ClipForge in Docker,
  sets a password, logs in to Claude (your subscription) and sets up phone access.

  Run in PowerShell **as Administrator**:
    irm https://raw.githubusercontent.com/Smaxhy/video-editing/main/deploy/install-windows.ps1 | iex

  Run it again any time to update. Optional settings (set before running):
    $env:CLIPFORGE_DIR    = "$HOME\ClipForge"   # install folder
    $env:CLIPFORGE_BRANCH = "main"
    $env:CLIPFORGE_WIFI   = "1"                  # also allow phones on your home Wi-Fi (no Tailscale needed)
#>
# 'Continue', not 'Stop': in Windows PowerShell 5.1, git/docker progress on stderr would otherwise abort
# the script. Every step checks $LASTEXITCODE (or uses -ErrorAction Stop) instead.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$Repo   = 'https://github.com/Smaxhy/video-editing.git'
$Dir    = if ($env:CLIPFORGE_DIR) { $env:CLIPFORGE_DIR } else { Join-Path $HOME 'ClipForge' }
$Branch = if ($env:CLIPFORGE_BRANCH) { $env:CLIPFORGE_BRANCH } else { 'main' }
$Wifi   = $env:CLIPFORGE_WIFI -eq '1'

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "`nError: $m" -ForegroundColor Red; throw $m }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Winget-Install($id, $name) {
  Write-Host "  installing $name…"
  winget install --id $id -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
  Refresh-Path
}
function Read-EnvFile($path) {
  $map = [ordered]@{}
  if (Test-Path $path) {
    foreach ($line in Get-Content $path) {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $map[$Matches[1]] = $Matches[2] }
    }
  }
  return $map
}
function Write-EnvFile($path, $map) {
  $text = ($map.Keys | ForEach-Object { "$_=$($map[$_])" }) -join "`n"
  # UTF-8 *without* BOM — Docker Compose can't read the first key if a BOM is present.
  [IO.File]::WriteAllText($path, "$text`n", (New-Object System.Text.UTF8Encoding $false))
}

# --- 0. Preconditions --------------------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'Open PowerShell as Administrator (right-click → Run as administrator) and run this again.' }
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Fail 'winget is missing. Install "App Installer" from the Microsoft Store, then run this again.'
}

# --- 1. WSL 2 + Docker Desktop -----------------------------------------------------------------
Step '1/7  WSL 2 and Docker Desktop'
wsl.exe --status *> $null
if ($LASTEXITCODE -ne 0) {
  wsl.exe --install --no-distribution
  Warn 'WSL was just installed. RESTART your PC, then run this same command again.'
  return
}
Ok 'WSL 2'

$dockerExe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
if (-not (Test-Path $dockerExe)) {
  Winget-Install 'Docker.DockerDesktop' 'Docker Desktop'
  Warn 'Docker Desktop was just installed. If Windows asks you to sign out or restart, do it, then run this again.'
}
Refresh-Path
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host '  starting Docker Desktop (accept its terms the first time it opens)…'
  Start-Process $dockerExe
  $deadline = (Get-Date).AddMinutes(6)
  do { Start-Sleep 5; docker info *> $null } while ($LASTEXITCODE -ne 0 -and (Get-Date) -lt $deadline)
  if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop did not start. Open it once from the Start menu, wait for "Engine running", then run this again.' }
}
Ok ((docker --version) -join '')
$memGb = [math]::Round(((docker info --format '{{.MemTotal}}') -as [double]) / 1GB, 1)
if ($memGb -lt 7) { Warn "Docker only has $memGb GB of memory. Docker Desktop → Settings → Resources → Memory: set 8 GB or more." }

# --- 2. Git + code ------------------------------------------------------------------------------
Step '2/7  ClipForge code'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Winget-Install 'Git.Git' 'Git' }
if (Test-Path (Join-Path $Dir '.git')) {
  git -C $Dir fetch -q origin $Branch
  git -C $Dir checkout -q $Branch
  git -C $Dir reset -q --hard "origin/$Branch"
  if ($LASTEXITCODE -ne 0) { Fail "Could not update $Dir (git)." }
  Ok "updated $Dir"
} else {
  git clone -q --branch $Branch $Repo $Dir
  if ($LASTEXITCODE -ne 0) { Fail "Could not download ClipForge (git clone $Repo)." }
  Ok "downloaded to $Dir"
}
Set-Location $Dir
$envPath = Join-Path $Dir '.env'
$cfg = Read-EnvFile $envPath

# --- 3. Build -----------------------------------------------------------------------------------
Step '3/7  Building ClipForge (first time: 10-25 minutes)'
docker compose build --pull
if ($LASTEXITCODE -ne 0) { Fail 'The Docker build failed — copy the error above (no passwords/tokens) and send it to Claude.' }
Ok 'image built'

# --- 4. Password + Claude login -----------------------------------------------------------------
Step '4/7  Password and Claude login'
$newPassword = $null
if (-not $cfg['CLIPFORGE_PASSWORD']) {
  $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  $newPassword = -join (1..20 | ForEach-Object { $chars | Get-Random })
  $cfg['CLIPFORGE_PASSWORD'] = $newPassword
  Ok 'generated an app password (shown at the end)'
} else { Ok 'keeping your existing app password' }

if (-not $cfg['CLAUDE_CODE_OAUTH_TOKEN']) {
  Write-Host ''
  Write-Host '  ClipForge uses your Claude Pro/Max subscription (never paid API credits).'
  Write-Host '  Claude will show a link: open it, log in, paste the code back. Then COPY the token it prints'
  Write-Host '  (starts with sk-ant-oat01-) — you will paste it right after.'
  Read-Host '  Press Enter to start the Claude login' | Out-Null
  docker run --rm -it --entrypoint claude clipforge:latest setup-token
  $secure = Read-Host '  Paste the token here (hidden)' -AsSecureString
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
  if (-not $token.StartsWith('sk-ant-')) { Fail "That doesn't look like a Claude token (it starts with sk-ant-). Run this again." }
  $cfg['CLAUDE_CODE_OAUTH_TOKEN'] = $token
  Ok 'Claude login saved'
} else { Ok 'keeping your existing Claude login' }

if ($Wifi) {
  $cfg['CLIPFORGE_BIND'] = '0.0.0.0'
  if (-not (Get-NetFirewallRule -DisplayName 'ClipForge' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'ClipForge' -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private -ErrorAction Stop | Out-Null
  }
}
Write-EnvFile $envPath $cfg

# --- 5. Start -----------------------------------------------------------------------------------
Step '5/7  Starting ClipForge'
docker compose up -d --remove-orphans
if ($LASTEXITCODE -ne 0) { Fail 'docker compose up failed — see the error above.' }
$up = $false
for ($i = 0; $i -lt 90 -and -not $up; $i++) {
  try { Invoke-WebRequest 'http://127.0.0.1:3000/api/auth' -UseBasicParsing -TimeoutSec 3 | Out-Null; $up = $true } catch { Start-Sleep 2 }
}
if (-not $up) { Fail "ClipForge didn't start. See: docker compose -f `"$Dir\docker-compose.yml`" logs" }
Ok 'running at http://localhost:3000 (starts with Docker Desktop)'

# --- 6. Tailscale -------------------------------------------------------------------------------
Step '6/7  Phone access with Tailscale (free, private, HTTPS)'
$ts = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if (-not (Test-Path $ts)) { Winget-Install 'tailscale.tailscale' 'Tailscale' }
& $ts status *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host '  Log in to Tailscale in the browser window (same account you will use on your phone).'
  & $ts up
}
Write-Host '  If Tailscale asks you to enable HTTPS, open its link and click Enable.'
& $ts serve --bg 3000 | Out-Null
$hostName = ((& $ts status --json) | ConvertFrom-Json).Self.DNSName.TrimEnd('.')
$url = "https://$hostName"
Ok "ClipForge is at $url"

# --- 7. Done ------------------------------------------------------------------------------------
Step '7/7  Done!'
$qrPng = Join-Path $Dir 'output\phone-qr.png'
docker exec clipforge node scripts/qr.js $url --png /app/output/phone-qr.png | Out-Null
Write-Host ''
Write-Host '  On your phone:'
Write-Host '    1. Install the Tailscale app and log in with the same account.'
Write-Host "    2. Scan the QR code that just opened (or type $url)"
Write-Host '    3. iPhone: Share -> Add to Home Screen.   Android: menu -> Install app.'
if (Test-Path $qrPng) { Start-Process $qrPng }
if ($Wifi) {
  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -eq 'Dhcp' } | Select-Object -First 1).IPAddress
  if ($ip) { Write-Host "    On home Wi-Fi you can also use http://${ip}:3000" }
}
Write-Host ''
if ($newPassword) { Write-Host "  App password: $newPassword   (save it — also in $envPath)" -ForegroundColor White }
else { Write-Host "  App password: unchanged (CLIPFORGE_PASSWORD in $envPath)" }
Write-Host '  Update later: run the same install command again.'
Write-Host ''
