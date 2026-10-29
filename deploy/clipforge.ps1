# `clipforge` on a Windows PC: one command to look after ClipForge (deploy/install-windows.ps1 puts a
# clipforge.cmd for it on your PATH). Run `clipforge help` for the list.
# Keep this file plain ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param([string]$Command = 'status', [string]$Arg = '')
$ErrorActionPreference = 'Continue'
$Dir = if ($env:CLIPFORGE_DIR) { $env:CLIPFORGE_DIR } else { Join-Path $HOME 'ClipForge' }
if (-not (Test-Path (Join-Path $Dir '.git'))) { Write-Host "ClipForge isn't installed in $Dir."; exit 1 }
Set-Location $Dir

function Get-EnvValue($key) {
  $line = Get-Content (Join-Path $Dir '.env') -ErrorAction SilentlyContinue | Where-Object { $_ -match "^$key=" } | Select-Object -Last 1
  if ($line) { return $line.Substring($key.Length + 1) } else { return '' }
}
function Get-Url {
  $ts = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  try { $name = ((& $ts status --json) | ConvertFrom-Json).Self.DNSName.TrimEnd('.'); if ($name) { return "https://$name" } } catch {}
  return 'http://localhost:3000'
}

switch ($Command) {
  'status' {
    $up = $false
    try { Invoke-WebRequest 'http://127.0.0.1:3000/api/auth' -UseBasicParsing -TimeoutSec 3 | Out-Null; $up = $true } catch {}
    Write-Host 'ClipForge' -ForegroundColor Cyan
    if ($up) { Write-Host '  [ok] running' -ForegroundColor Green }
    else {
      docker info *> $null
      if ($LASTEXITCODE -ne 0) { Write-Host '  [x] Docker Desktop is not running - open it from the Start menu' -ForegroundColor Red }
      else { Write-Host '  [x] not answering - try: clipforge restart' -ForegroundColor Red }
    }
    Write-Host "  version:  $(git rev-parse --short HEAD) ($(git log -1 --format=%cr))"
    Write-Host "  on PC:    http://localhost:3000"
    Write-Host "  phone:    $(Get-Url)"
    $act = Join-Path $Dir 'workspace\activity.json'
    if (Test-Path $act) {
      try {
        $d = Get-Content $act -Raw | ConvertFrom-Json
        $fresh = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$d.at -lt 120000
        Write-Host "  doing:    $(if ($fresh -and $d.busy) { $d.busy } else { 'nothing (idle)' })"
      } catch {}
    }
    $drive = (Get-Item $Dir).PSDrive
    Write-Host ("  disk:     {0:N0} GB free on {1}:" -f ($drive.Free / 1GB), $drive.Name)
    $task = Get-ScheduledTask -TaskName 'ClipForge update' -ErrorAction SilentlyContinue
    Write-Host "  updates:  $(if ($task) { 'automatic (every 5 minutes, never mid-render)' } else { 'off - run the install command again' })"
  }
  'url' {
    $url = Get-Url
    Write-Host $url
    docker exec clipforge node scripts/qr.js $url
  }
  'password' { Write-Host "App password: $(Get-EnvValue 'CLIPFORGE_PASSWORD')" }
  'open' { Start-Process 'http://localhost:3000' }
  'logs' { docker compose logs -f --tail $(if ($Arg) { $Arg } else { 200 }) }
  'restart' { docker compose up -d --remove-orphans *> $null; docker restart clipforge *> $null; Write-Host 'Restarted.' }
  'stop' { docker compose stop; Write-Host 'Stopped. Start it again with: clipforge start' }
  'start' { docker compose up -d --remove-orphans; Write-Host 'Started.' }
  'update' {
    New-Item -ItemType Directory -Force (Join-Path $Dir 'workspace') | Out-Null
    Set-Content (Join-Path $Dir 'workspace\.update-now') (Get-Date -Format s)
    Write-Host 'Updating (building a new version can take a few minutes)...'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dir 'deploy\windows-update.ps1') -Dir $Dir
    Write-Host "Up to date ($(git rev-parse --short HEAD))."
  }
  'clean' {
    Write-Host 'Removing old ClipForge versions and Docker build cache (your videos are kept)...'
    docker image prune -f
    docker builder prune -af
    Write-Host 'Done. The next update rebuilds from scratch once (10-25 minutes, in the background).'
  }
  'space' {
    docker system df
    docker exec clipforge du -sh /app/library /app/output /app/workspace /app/uploads /root/.cache
    $drive = (Get-Item $Dir).PSDrive
    Write-Host ("{0:N0} GB free on {1}:" -f ($drive.Free / 1GB), $drive.Name)
  }
  default {
    Write-Host @'
clipforge            status: running?, version, links, what it's doing, disk
clipforge open       open ClipForge in your browser on this PC
clipforge url        the link for your phone (+ QR code)
clipforge password   show the app password
clipforge logs       live log (Ctrl+C to leave)
clipforge restart    restart ClipForge
clipforge update     install the newest version now (stops a stuck render)
clipforge space      what's using the disk (ClipForge + Docker)
clipforge clean      free space: delete old versions + Docker build cache (videos kept)
clipforge stop | start
To log in to Claude again: delete the CLAUDE_CODE_OAUTH_TOKEN line in .env and run the install command.
'@
  }
}
