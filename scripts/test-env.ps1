# Snack Overflow local test environment (Windows).
# Runs the real Docker stack under its own project name, port and data, separate
# from any real install. Used by start-test-env.bat and stop-test-env.bat.
#
#   test-env.ps1 start   build (if needed), start, wait until ready, open the browser
#   test-env.ps1 stop    stop it (data is kept)
#   test-env.ps1 reset   stop it and delete its data (fresh household next start)
#   test-env.ps1 logs    follow the app's logs

param([ValidateSet('start', 'stop', 'reset', 'logs')][string]$Action = 'start')

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $Root '.env.test'
$Project = 'snackoverflow-test'
Set-Location $Root

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Bad($msg) { Write-Host $msg -ForegroundColor Red }

function New-Secret([int]$bytes = 32) {
    $buf = New-Object byte[] $bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
    return -join ($buf | ForEach-Object { $_.ToString('x2') })
}

function Read-EnvValue([string]$name) {
    $line = Get-Content $EnvFile | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
    if ($null -eq $line) { return '' }
    return $line.Substring($name.Length + 1)
}

function Invoke-Compose([string[]]$composeArgs) {
    & docker compose -p $Project --env-file $EnvFile @composeArgs
    if ($LASTEXITCODE -ne 0) { throw "docker compose $($composeArgs -join ' ') failed." }
}

function Wait-Docker {
    & docker info *> $null
    if ($LASTEXITCODE -eq 0) { return }
    $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (-not (Test-Path $desktop)) { throw 'Docker is not running and Docker Desktop was not found. Install or start Docker first.' }
    Write-Step 'Starting Docker Desktop (this can take a minute)...'
    Start-Process $desktop
    for ($i = 0; $i -lt 90; $i++) {
        Start-Sleep -Seconds 2
        & docker info *> $null
        if ($LASTEXITCODE -eq 0) { return }
    }
    throw 'Docker did not start in time. Start Docker Desktop, then try again.'
}

function New-TestEnvFile {
    Write-Step 'Creating .env.test with fresh secrets (git-ignored)...'
    $adminPassword = (New-Secret 6)
    $vapidPublic = ''
    $vapidPrivate = ''
    try {
        # Generate Web Push keys so notifications work on this PC (localhost counts as secure).
        $json = & node -e "const wp=require('./apps/server/node_modules/web-push');console.log(JSON.stringify(wp.generateVAPIDKeys()))" 2>$null
        if ($LASTEXITCODE -eq 0 -and $json) {
            $keys = $json | ConvertFrom-Json
            $vapidPublic = $keys.publicKey
            $vapidPrivate = $keys.privateKey
        }
    } catch { }
    $lines = @(
        '# Local test environment for start-test-env.bat. Never commit this file.',
        'APP_ENV_FILE=.env.test',
        'NODE_ENV=production',
        'PORT=3080',
        'APP_URL=http://localhost:3080',
        'TZ=Europe/London',
        "SESSION_SECRET=$(New-Secret 32)",
        'POSTGRES_USER=snackoverflow',
        "POSTGRES_PASSWORD=$(New-Secret 16)",
        'POSTGRES_DB=snackoverflow',
        'ADMIN_EMAIL=admin@example.com',
        "ADMIN_PASSWORD=$adminPassword",
        'ADMIN_NAME=Tester',
        'HOUSEHOLD_NAME=Test household',
        'OFF_USER_AGENT=SnackOverflow/0.1 (local test)',
        "VAPID_PUBLIC_KEY=$vapidPublic",
        "VAPID_PRIVATE_KEY=$vapidPrivate",
        'VAPID_SUBJECT=mailto:admin@example.com',
        'BACKUP_KEEP_DAYS=3'
    )
    Set-Content -Path $EnvFile -Value $lines -Encoding ascii
}

function Show-Info {
    $port = Read-EnvValue 'PORT'
    Write-Host ''
    Write-Host 'Snack Overflow test environment is running.' -ForegroundColor Green
    Write-Host "  Open:      http://localhost:$port"
    Write-Host "  Email:     $(Read-EnvValue 'ADMIN_EMAIL')"
    Write-Host "  Password:  $(Read-EnvValue 'ADMIN_PASSWORD')"
    $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object -ExpandProperty IPAddress
    if ($ips) {
        Write-Host ''
        Write-Host '  On a phone on the same Wi-Fi:'
        foreach ($ip in $ips) { Write-Host "             http://${ip}:$port" }
        Write-Host '  (Phones only allow the camera over HTTPS, so use the keyboard button to type barcodes there.'
        Write-Host '   On this PC the camera works at localhost.)'
    }
    Write-Host ''
    Write-Host '  Stop it with stop-test-env.bat. Data is kept between runs; "scripts\test-env.ps1 reset" wipes it.'
}

switch ($Action) {
    'start' {
        Wait-Docker
        if (-not (Test-Path $EnvFile)) { New-TestEnvFile }
        Write-Step 'Building and starting (the first build downloads a lot and can take several minutes)...'
        Invoke-Compose @('up', '-d', '--build')
        $port = Read-EnvValue 'PORT'
        Write-Step 'Waiting for the app to be ready...'
        $ready = $false
        for ($i = 0; $i -lt 90; $i++) {
            try {
                $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://localhost:$port/api/health"
                if ($r.StatusCode -eq 200) { $ready = $true; break }
            } catch { }
            Start-Sleep -Seconds 2
        }
        if (-not $ready) {
            Write-Bad 'The app did not come up. Last log lines:'
            & docker compose -p $Project --env-file $EnvFile logs --tail 40 app
            exit 1
        }
        Show-Info
        Start-Process "http://localhost:$port"
    }
    'stop' {
        if (-not (Test-Path $EnvFile)) { Write-Host 'No test environment has been set up.'; exit 0 }
        Write-Step 'Stopping the test environment (data is kept)...'
        Invoke-Compose @('down')
    }
    'reset' {
        if (-not (Test-Path $EnvFile)) { Write-Host 'No test environment has been set up.'; exit 0 }
        Write-Step 'Stopping and deleting the test data...'
        Invoke-Compose @('down', '-v')
        Write-Host 'Done. The next start creates a fresh household.'
    }
    'logs' {
        if (-not (Test-Path $EnvFile)) { Write-Host 'No test environment has been set up.'; exit 0 }
        & docker compose -p $Project --env-file $EnvFile logs -f app
    }
}
