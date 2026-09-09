<#
.SYNOPSIS
    Set DropshipHub up on a Windows server.

.DESCRIPTION
    Checks the prerequisites, fetches the code, creates the database, writes a
    .env with a freshly generated encryption key, installs, migrates and builds,
    and writes a Caddy config for HTTPS. It stops with a clear message rather
    than guessing whenever something is missing.

    It does not install Node, PostgreSQL, Caddy or NSSM for you — an installer
    that silently changes a production server is worse than one line of output
    telling you what to run. Each check prints the exact winget command.

    Safe to run again: an existing checkout is updated rather than re-cloned, an
    existing database is left alone, and an existing .env keeps its keys.

.PARAMETER Domain
    The public domain Shopify will call, e.g. windspace.agency. Used for
    SHOPIFY_APP_URL and the Caddy site block.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1 -Domain windspace.agency -PgPassword 'your-postgres-password'
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Domain,

    [string]$InstallPath = "C:\dropshiphub",
    [string]$RepoUrl = "https://github.com/thanhvlad/thanhvlad.git",
    [string]$Branch = "claude/shopify-app-dser-clone-37dhdv",

    [string]$PgUser = "postgres",
    [string]$PgPassword = "",
    [string]$PgHost = "localhost",
    [int]$PgPort = 5432,
    [string]$DbName = "dropship_hub",

    [string]$CaddyPath = "C:\caddy",
    [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$script:Problems = @()

function Write-Step($Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok($Message) {
    Write-Host "    OK  $Message" -ForegroundColor Green
}

function Write-Problem($Message, $Fix) {
    Write-Host "    !!  $Message" -ForegroundColor Yellow
    if ($Fix) { Write-Host "        Fix: $Fix" -ForegroundColor Yellow }
    $script:Problems += $Message
}

function Test-Command($Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------
Write-Step "Checking prerequisites"

if (Test-Command "node") {
    $nodeRaw = (& node --version).Trim().TrimStart("v")
    $nodeMajor = [int]($nodeRaw.Split(".")[0])
    if ($nodeMajor -ge 22) { Write-Ok "Node $nodeRaw" }
    else { Write-Problem "Node $nodeRaw is too old; 22 or newer is required." "winget install OpenJS.NodeJS.LTS" }
} else {
    Write-Problem "Node.js is not installed." "winget install OpenJS.NodeJS.LTS"
}

if (Test-Command "git") { Write-Ok "git" } else { Write-Problem "git is not installed." "winget install Git.Git" }

$psql = $null
if (Test-Command "psql") {
    $psql = "psql"
} else {
    $candidate = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($candidate) { $psql = $candidate.FullName }
}
if ($psql) { Write-Ok "PostgreSQL client at $psql" }
else { Write-Problem "PostgreSQL is not installed." "winget install PostgreSQL.PostgreSQL.16" }

if ($script:Problems.Count -gt 0) {
    Write-Host ""
    Write-Host "Install what is listed above, then run this script again." -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# 2. Code
# ---------------------------------------------------------------------------
Write-Step "Fetching the code into $InstallPath"

if (Test-Path (Join-Path $InstallPath ".git")) {
    Push-Location $InstallPath
    & git fetch origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }
    & git checkout $Branch
    & git reset --hard "origin/$Branch"
    Pop-Location
    Write-Ok "Updated the existing checkout to the latest $Branch"
} else {
    & git clone --branch $Branch $RepoUrl $InstallPath
    if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
    Write-Ok "Cloned $Branch"
}

# ---------------------------------------------------------------------------
# 3. Database
# ---------------------------------------------------------------------------
Write-Step "Preparing the database"

if ($PgPassword) { $env:PGPASSWORD = $PgPassword }
$exists = & $psql -U $PgUser -h $PgHost -p $PgPort -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DbName'" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Problem "Could not reach PostgreSQL as '$PgUser' on ${PgHost}:${PgPort}." "Check the service is running and pass -PgPassword"
    Write-Host ""
    Write-Host "Stopping: the database has to answer before anything else is worth doing." -ForegroundColor Red
    exit 1
}
if ($exists -eq "1") {
    Write-Ok "Database '$DbName' already exists"
} else {
    & $psql -U $PgUser -h $PgHost -p $PgPort -d postgres -c "CREATE DATABASE $DbName" | Out-Null
    Write-Ok "Created database '$DbName'"
}

# ---------------------------------------------------------------------------
# 4. Environment
# ---------------------------------------------------------------------------
Write-Step "Writing the environment file"

$envPath = Join-Path $InstallPath ".env"
$encryptionKey = $null
if (Test-Path $envPath) {
    # Keep the existing key: rotating it makes every stored supplier token
    # undecryptable, and every merchant would have to reconnect their account.
    $existing = Get-Content $envPath | Where-Object { $_ -match "^ENCRYPTION_KEY=(.+)$" } | Select-Object -First 1
    if ($existing) {
        $encryptionKey = ($existing -split "=", 2)[1].Trim()
        Write-Ok "Kept the existing ENCRYPTION_KEY"
    }
    Copy-Item $envPath "$envPath.backup" -Force
    Write-Ok "Backed the old .env up to .env.backup"
}
if (-not $encryptionKey) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $encryptionKey = [Convert]::ToBase64String($bytes)
    Write-Ok "Generated a new ENCRYPTION_KEY"
}

$escapedUser = [uri]::EscapeDataString($PgUser)
$escapedPassword = [uri]::EscapeDataString($PgPassword)
$databaseUrl = "postgresql://${escapedUser}:${escapedPassword}@${PgHost}:${PgPort}/${DbName}?schema=public"

$envLines = @(
    "NODE_ENV=production",
    "PORT=$Port",
    "SHOPIFY_APP_URL=https://$Domain",
    "",
    '# Filled in by "shopify app config link" / the Partner Dashboard.',
    "SHOPIFY_API_KEY=",
    "SHOPIFY_API_SECRET=",
    "SCOPES=read_products,write_products,read_publications,write_publications,read_orders,write_orders,read_fulfillments,write_fulfillments,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders,read_assigned_fulfillment_orders,write_assigned_fulfillment_orders,read_inventory,write_inventory,read_locations,read_customers",
    "",
    "DATABASE_URL=$databaseUrl",
    "",
    "# One process does the background work too. Add Redis and a second",
    "# service when losing queued jobs on a restart starts to matter.",
    "REDIS_URL=",
    "RUN_WORKER_IN_WEB=true",
    "",
    "# Switch to live once an AliExpress account is connected.",
    "SUPPLIER_DRIVER=mock",
    "ALIEXPRESS_APP_KEY=",
    "ALIEXPRESS_APP_SECRET=",
    "",
    "ENCRYPTION_KEY=$encryptionKey",
    "SUPPORT_EMAIL=",
    "LOG_LEVEL=info"
)
Set-Content -Path $envPath -Value $envLines -Encoding UTF8
Write-Ok "Wrote $envPath"

# ---------------------------------------------------------------------------
# 5. Install, migrate, build
# ---------------------------------------------------------------------------
Push-Location $InstallPath
try {
    Write-Step "Installing dependencies (a few minutes the first time)"
    & npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    Write-Ok "Dependencies installed"

    Write-Step "Creating the database tables"
    & npx prisma generate
    if ($LASTEXITCODE -ne 0) { throw "prisma generate failed" }
    & npx prisma migrate deploy
    if ($LASTEXITCODE -ne 0) { throw "prisma migrate deploy failed" }
    Write-Ok "Schema is up to date"

    Write-Step "Building"
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "build failed" }
    Write-Ok "Built"
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# 6. Caddy config for HTTPS
# ---------------------------------------------------------------------------
Write-Step "Writing the Caddy config"

if (-not (Test-Path $CaddyPath)) { New-Item -ItemType Directory -Path $CaddyPath -Force | Out-Null }
$caddyfile = Join-Path $CaddyPath "Caddyfile"
$caddyLines = @(
    "$Domain {",
    "    reverse_proxy 127.0.0.1:$Port",
    "}"
)
Set-Content -Path $caddyfile -Value $caddyLines -Encoding ASCII
Write-Ok "Wrote $caddyfile"
if (-not (Test-Path (Join-Path $CaddyPath "caddy.exe"))) {
    Write-Problem "caddy.exe is not in $CaddyPath yet." "Download the Windows amd64 build from https://caddyserver.com/download and put caddy.exe there"
}

# ---------------------------------------------------------------------------
# 7. What is left
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "Setup finished." -ForegroundColor Green
Write-Host ""
Write-Host "Check it runs:" -ForegroundColor White
Write-Host "    cd $InstallPath"
Write-Host "    npm run start"
Write-Host "    (in another window)  curl http://localhost:$Port/healthz"
Write-Host ""
Write-Host "Then serve it over HTTPS:" -ForegroundColor White
Write-Host "    cd $CaddyPath"
Write-Host "    .\caddy.exe run"
Write-Host "    open https://$Domain/healthz from another machine"
Write-Host ""
Write-Host "Then keep both running as Windows services (nssm.cc):" -ForegroundColor White
Write-Host "    nssm install DropshipHub `"$((Get-Command node).Source)`" `"$InstallPath\node_modules\@remix-run\serve\dist\cli.js`" `"$InstallPath\build\server\index.js`""
Write-Host "    nssm set DropshipHub AppDirectory $InstallPath"
Write-Host "    nssm start DropshipHub"
Write-Host "    nssm install Caddy `"$CaddyPath\caddy.exe`" run"
Write-Host "    nssm set Caddy AppDirectory $CaddyPath"
Write-Host "    nssm start Caddy"
Write-Host ""
Write-Host "Then connect it to Shopify, from your own machine in a checkout of this repo:" -ForegroundColor White
Write-Host "    shopify app config link"
Write-Host "    shopify app deploy"
Write-Host "  and copy SHOPIFY_API_KEY and SHOPIFY_API_SECRET from the Partner Dashboard"
Write-Host "  into $envPath, then restart the DropshipHub service."
Write-Host ""
Write-Host "See docs/PUBLISHING.md for the rest of the App Store checklist." -ForegroundColor White

if ($script:Problems.Count -gt 0) {
    Write-Host ""
    Write-Host "Still outstanding:" -ForegroundColor Yellow
    foreach ($p in $script:Problems) { Write-Host "  - $p" -ForegroundColor Yellow }
}
