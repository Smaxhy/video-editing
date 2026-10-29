# ClipForge auto-update for Windows PCs. The "ClipForge update" scheduled task that
# deploy/install-windows.ps1 sets up runs it every 5 minutes. It does the same as deploy/server-update.sh:
# when GitHub has a new version it builds it, waits until nothing is rendering, then swaps it in. The
# app's "Stop everything & update" button drops workspace\.update-now, which skips the wait (and
# restarts even when there is nothing new).
# Keep this file plain ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
  [string]$Dir = $(if ($env:CLIPFORGE_DIR) { $env:CLIPFORGE_DIR } else { Join-Path $HOME 'ClipForge' }),
  [string]$Branch = $(if ($env:CLIPFORGE_BRANCH) { $env:CLIPFORGE_BRANCH } else { 'main' })
)
$ErrorActionPreference = 'Continue'
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (Test-Path (Join-Path $Dir '.git'))) { exit 0 }
Set-Location $Dir

$logFile = Join-Path $Dir 'update.log'
if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 1MB) { Remove-Item $logFile -Force }
function Log($m) { "$(Get-Date -Format s)  $m" | Add-Content $logFile }

# ClipForge writes workspace\activity.json every 20 s: { at, busy } (busy = what's running, or null).
function Test-Busy {
  $f = Join-Path $Dir 'workspace\activity.json'
  if (-not (Test-Path $f)) { return $false }
  try { $d = Get-Content $f -Raw | ConvertFrom-Json } catch { return $false }
  $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$d.at
  return [bool]$d.busy -and $age -lt 120000
}

# One update at a time.
$mutex = New-Object Threading.Mutex($false, 'ClipForgeUpdate')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
  docker info *> $null
  if ($LASTEXITCODE -ne 0) { exit 0 } # Docker Desktop isn't running (yet)

  $flag = Join-Path $Dir 'workspace\.update-now'
  $forced = Test-Path $flag
  if ($forced) { Remove-Item $flag -Force }

  git fetch -q origin $Branch 2>$null
  if ($LASTEXITCODE -ne 0) { if ($forced) { Log 'GitHub unreachable - restarting anyway' } else { exit 0 } }
  $new = (git rev-parse HEAD) -ne (git rev-parse "origin/$Branch")
  if (-not $new -and -not $forced) { exit 0 }

  if ($new) {
    Log "new version $(git rev-parse --short "origin/$Branch") - building"
    git reset -q --hard "origin/$Branch"
    docker compose build -q 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Log 'build failed - keeping the running version'; exit 1 }
  }
  # Swap in when idle (a forced update doesn't wait). Give up after 3 hours; the next run retries.
  if (-not $forced) {
    for ($i = 0; $i -lt 180 -and (Test-Busy); $i++) { Start-Sleep 60 }
    if (Test-Busy) { Log 'still busy - will retry'; exit 0 }
  }
  if ($new) { docker compose up -d --remove-orphans 2>&1 | Out-Null }
  else { docker compose up -d --remove-orphans --force-recreate 2>&1 | Out-Null }
  docker image prune -f *> $null # old versions' images take gigabytes
  docker builder prune -f --filter until=168h *> $null # and so does old build cache
  Log "running $(git rev-parse --short HEAD)"
} finally {
  $mutex.ReleaseMutex()
}
