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
    $env:CLIPFORGE_WIFI   = "1"                  # phones on your home Wi-Fi (skips Tailscale entirely)
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
# Docker Desktop's install folder differs between versions and per-user / all-users installs.
function Find-DockerDesktop {
  $cands = @(
    (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Docker\Docker\Docker Desktop.exe'),
    (Join-Path $env:LOCALAPPDATA 'Docker\Docker Desktop.exe')
  )
  foreach ($key in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop',
                   'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop') {
    $loc = (Get-ItemProperty $key -ErrorAction SilentlyContinue).InstallLocation
    if ($loc) { $cands += (Join-Path $loc 'Docker Desktop.exe') }
  }
  # Next to the docker command, or wherever it is running right now.
  $cli = Get-Command docker -ErrorAction SilentlyContinue
  if ($cli -and $cli.Source) { $cands += (Join-Path (Split-Path (Split-Path (Split-Path $cli.Source))) 'Docker Desktop.exe') }
  $proc = Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($proc -and $proc.Path) { $cands += $proc.Path }
  # The Start menu shortcut, and other drives (installed to D:\ etc.).
  $shell = New-Object -ComObject WScript.Shell
  foreach ($menu in "$env:ProgramData\Microsoft\Windows\Start Menu\Programs", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs") {
    foreach ($l in Get-ChildItem $menu -Recurse -Filter 'Docker Desktop.lnk' -ErrorAction SilentlyContinue) {
      $cands += $shell.CreateShortcut($l.FullName).TargetPath
    }
  }
  foreach ($d in Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue) {
    $cands += (Join-Path $d.Root 'Program Files\Docker\Docker\Docker Desktop.exe')
  }
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}
function Find-Tailscale {
  $cands = @((Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'), (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe'))
  $cli = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($cli -and $cli.Source) { $cands += $cli.Source }
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
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
Step '1/8  WSL 2 and Docker Desktop'
wsl.exe --status *> $null
if ($LASTEXITCODE -ne 0) {
  wsl.exe --install --no-distribution
  Warn 'WSL was just installed. RESTART your PC, then run this same command again.'
  return
}
Ok 'WSL 2'

Refresh-Path
$dockerCli = [bool](Get-Command docker -ErrorAction SilentlyContinue)
$dockerReady = $false
if ($dockerCli) { docker info *> $null; $dockerReady = $LASTEXITCODE -eq 0 }
$dockerExe = Find-DockerDesktop
if ($dockerReady) { Ok 'using the Docker you already have' }
elseif ($dockerCli -and -not $dockerExe) {
  Fail 'Docker is installed but not running. Open Docker Desktop, wait until it says "Engine running", then run this again.'
}
elseif (-not $dockerExe) {
  Write-Host '  installing Docker Desktop (a big download - a few minutes)…'
  winget install --id Docker.DockerDesktop -e --silent --accept-source-agreements --accept-package-agreements
  $dockerExe = Find-DockerDesktop
  if (-not $dockerExe) {
    # winget fails on some PCs (old App Installer, store issues): get Docker's own installer instead.
    Write-Host '  winget could not install it - downloading Docker Desktop directly…'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
    $setup = Join-Path $env:TEMP 'DockerDesktopInstaller.exe'
    try {
      Invoke-WebRequest "https://desktop.docker.com/win/main/$arch/Docker%20Desktop%20Installer.exe" -OutFile $setup -UseBasicParsing -ErrorAction Stop
      Start-Process $setup -ArgumentList 'install', '--quiet', '--accept-license' -Wait
    } catch { Warn "download failed: $($_.Exception.Message)" }
    $dockerExe = Find-DockerDesktop
  }
  if (-not $dockerExe) {
    Fail 'Docker Desktop did not install. Restart the PC and run this again. Still failing? Install it from https://www.docker.com/products/docker-desktop/ then run this again.'
  }
  Ok 'Docker Desktop installed'
  Warn 'If Windows asks you to sign out or restart, do it, then run this same command again.'
}
Refresh-Path
# The docker command lives next to Docker Desktop (and may not be on this window's PATH yet).
if ($dockerExe) {
  $dockerBin = Join-Path (Split-Path $dockerExe) 'resources\bin'
  if ((Test-Path $dockerBin) -and -not (Get-Command docker -ErrorAction SilentlyContinue)) { $env:Path += ";$dockerBin" }
}
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
Step '2/8  ClipForge code'
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
Step '3/8  Building ClipForge (first time: 10-25 minutes)'
# Plain `docker build`: `docker compose build` refuses to start until the password and Claude login
# below are in .env, and the login needs this image. Same image name and build args as docker-compose.yml.
$whisperx = if ($cfg['WITH_WHISPERX']) { $cfg['WITH_WHISPERX'] } else { '0' }
docker build --pull -t clipforge:latest --build-arg "WITH_WHISPERX=$whisperx" --build-arg "CLIPFORGE_VERSION=$(git rev-parse --short HEAD)" .
if ($LASTEXITCODE -ne 0) { Fail 'The Docker build failed — copy the error above (no passwords/tokens) and send it to Claude.' }
Ok 'image built'
docker image prune -f *> $null                        # earlier versions' images
docker builder prune -f --filter until=168h *> $null  # and build cache older than a week

# --- 4. Password + Claude login -----------------------------------------------------------------
Step '4/8  Password and Claude login'
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
  # Any profile: many home Wi-Fis are marked "Public" in Windows, which would block the phone. The app
  # itself is password-protected.
  if (Get-NetFirewallRule -DisplayName 'ClipForge' -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -DisplayName 'ClipForge' -Profile Any | Out-Null
  } else {
    New-NetFirewallRule -DisplayName 'ClipForge' -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Any -ErrorAction Stop | Out-Null
  }
}
Write-EnvFile $envPath $cfg

# --- 5. Start -----------------------------------------------------------------------------------
Step '5/8  Starting ClipForge'
docker compose up -d --remove-orphans
if ($LASTEXITCODE -ne 0) { Fail 'docker compose up failed — see the error above.' }
$up = $false
for ($i = 0; $i -lt 90 -and -not $up; $i++) {
  try { Invoke-WebRequest 'http://127.0.0.1:3000/api/auth' -UseBasicParsing -TimeoutSec 3 | Out-Null; $up = $true } catch { Start-Sleep 2 }
}
if (-not $up) { Fail "ClipForge didn't start. See: docker compose -f `"$Dir\docker-compose.yml`" logs" }
Ok 'running at http://localhost:3000 (starts with Docker Desktop)'

# --- 6. Tailscale -------------------------------------------------------------------------------
$wifiIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -eq 'Dhcp' } | Select-Object -First 1).IPAddress
if ($Wifi) {
  # Wi-Fi mode: the phone opens the PC's address on the same network — no Tailscale, no extra login.
  Step '6/8  Phone access on your home Wi-Fi'
  $url = if ($wifiIp) { "http://${wifiIp}:3000" } else { 'http://localhost:3000' }
  if ($wifiIp) { Ok "phones on your Wi-Fi open $url" } else { Warn 'could not find this PC''s Wi-Fi address (ipconfig shows it as IPv4 Address)' }
} else {
Step '6/8  Phone access with Tailscale (free, private, HTTPS)'
$ts = Find-Tailscale
if (-not $ts) {
  Write-Host '  installing Tailscale…'
  winget install --id tailscale.tailscale -e --silent --accept-source-agreements --accept-package-agreements
  $ts = Find-Tailscale
  if (-not $ts) {
    Write-Host '  winget could not install it - downloading Tailscale directly…'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
    $msi = Join-Path $env:TEMP 'tailscale-setup.msi'
    try {
      Invoke-WebRequest "https://pkgs.tailscale.com/stable/tailscale-setup-latest-$arch.msi" -OutFile $msi -UseBasicParsing -ErrorAction Stop
      Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/quiet', '/norestart' -Wait
    } catch { Warn "download failed: $($_.Exception.Message)" }
    $ts = Find-Tailscale
  }
}
$url = 'http://localhost:3000'
if ($ts) {
  # The Tailscale service needs a moment after a fresh install.
  for ($i = 0; $i -lt 10; $i++) { & $ts version *> $null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 2 }
  & $ts status *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host '  Log in to Tailscale: open the link below (same account you will use on your phone).'
    & $ts up
  }
  Write-Host '  If Tailscale asks you to enable HTTPS, open its link and click Enable.'
  & $ts serve --bg 3000 | Out-Null
  $hostName = $null
  try { $hostName = ((& $ts status --json) | ConvertFrom-Json).Self.DNSName.TrimEnd('.') } catch {}
  if ($hostName) {
    $url = "https://$hostName"
    Ok "ClipForge is at $url"
  } else { Warn 'Tailscale is installed but not logged in yet. Run this installer again to finish phone access.' }
} else {
  Warn 'Tailscale did not install. Get it from https://tailscale.com/download/windows, log in, then run this again.'
}
}

# --- 7. Automatic updates, start with Windows, stay awake, shortcuts --------------------------------
Step '7/8  Automatic updates and start-up'
$appData = Join-Path $env:LOCALAPPDATA 'ClipForge'
$binDir = Join-Path $appData 'bin'
New-Item -ItemType Directory -Force $binDir | Out-Null

# Every 5 minutes: install a new version when there is one (never mid-render). Run through a tiny
# VBScript so no PowerShell window flashes up each time.
$updScript = Join-Path $Dir 'deploy\windows-update.ps1'
$cmdLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}" -Dir "{1}" -Branch {2}' -f $updScript, $Dir, $Branch
$vbs = Join-Path $appData 'update-hidden.vbs'
[IO.File]::WriteAllText($vbs, ('CreateObject("WScript.Shell").Run "{0}", 0, False' -f ($cmdLine -replace '"', '""')) + "`r`n", [Text.Encoding]::ASCII)
try {
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 4)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName 'ClipForge update' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
  Ok 'automatic updates on (every 5 minutes, never mid-render)'
} catch { Warn "could not set up automatic updates ($($_.Exception.Message)) - run this installer again to update" }

# Start with Windows: Docker Desktop opens at sign-in, and ClipForge starts with it.
if ($dockerExe) {
  $startup = [Environment]::GetFolderPath('Startup')
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut((Join-Path $startup 'Docker Desktop.lnk'))
  $lnk.TargetPath = $dockerExe
  $lnk.Save()
  Ok 'starts by itself when you sign in to Windows'
} else { Warn 'make sure your Docker starts with Windows, so ClipForge does too' }

# A sleeping PC can't make videos: don't sleep while plugged in (the screen still turns off).
if ($env:CLIPFORGE_KEEP_AWAKE -ne '0') {
  powercfg /change standby-timeout-ac 0 | Out-Null
  powercfg /change hibernate-timeout-ac 0 | Out-Null
  Ok 'PC stays awake while plugged in (set $env:CLIPFORGE_KEEP_AWAKE = "0" before installing to skip)'
}

# Desktop shortcut + the `clipforge` command.
[IO.File]::WriteAllText((Join-Path ([Environment]::GetFolderPath('Desktop')) 'ClipForge.url'), "[InternetShortcut]`r`nURL=http://localhost:3000`r`n", [Text.Encoding]::ASCII)
$cmdText = "@echo off`r`nsetlocal`r`nset `"CLIPFORGE_DIR=$Dir`"`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$Dir\deploy\clipforge.ps1`" %*`r`n"
[IO.File]::WriteAllText((Join-Path $binDir 'clipforge.cmd'), $cmdText, [Text.Encoding]::Default)
$userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $binDir)) {
  [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';'), $binDir) -join ';').TrimStart(';'), 'User')
}
Ok "desktop shortcut + the 'clipforge' command (open a new terminal, then: clipforge help)"

# --- 8. Done ------------------------------------------------------------------------------------
Step '8/8  Done!'
$qrPng = Join-Path $Dir 'output\phone-qr.png'
docker exec clipforge node scripts/qr.js $url --png /app/output/phone-qr.png | Out-Null
Write-Host ''
Write-Host '  On your phone:'
if ($Wifi) {
  Write-Host '    1. Connect the phone to the same Wi-Fi as this PC (Tailscale off).'
} else {
  Write-Host '    1. Install the Tailscale app and log in with the same account.'
}
Write-Host "    2. Scan the QR code that just opened (or type $url)"
Write-Host '    3. iPhone: Share -> Add to Home Screen.   Android: menu -> Install app.'
if ((Test-Path $qrPng) -and $url -notlike '*localhost*') {
  # No picture viewer on some PCs (e.g. Windows Server): fall back to the browser, then to the file path.
  try { Start-Process $qrPng -ErrorAction Stop }
  catch {
    try { Start-Process 'msedge.exe' -ArgumentList "`"$qrPng`"" -ErrorAction Stop }
    catch { Write-Host "    (QR code picture: $qrPng)" }
  }
}
if (-not $Wifi -and $wifiIp -and (Get-NetFirewallRule -DisplayName 'ClipForge' -ErrorAction SilentlyContinue)) {
  Write-Host "    On home Wi-Fi you can also use http://${wifiIp}:3000"
}
Write-Host ''
if ($newPassword) { Write-Host "  App password: $newPassword   (save it — also in $envPath)" -ForegroundColor White }
else { Write-Host "  App password: unchanged (CLIPFORGE_PASSWORD in $envPath)" }
Write-Host '  Updates install themselves. Check on it any time: open a terminal and type  clipforge'
Write-Host '  (clipforge open / url / password / logs / update / help)'
Write-Host ''
