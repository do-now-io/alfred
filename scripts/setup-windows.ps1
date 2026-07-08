# Alfred — Windows dev setup
#
# Prepares everything the Rust backend needs to compile on Windows:
#   1. verifies the Rust toolchain (rustup/cargo) is installed
#   2. installs sqlx-cli if missing
#   3. creates the compile-time dev database (src-tauri/alfred_dev.db) and
#      applies all migrations, so the `sqlx::query!` macros can verify against
#      the schema at build time.
#
# Run from the repo root:  ./scripts/setup-windows.ps1

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$tauriDir = Join-Path $repoRoot "src-tauri"

function Require-Command($name, $hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Write-Error "Missing '$name'. $hint"
    }
}

Write-Host "==> Checking prerequisites..." -ForegroundColor Cyan
Require-Command "cargo" "Install Rust from https://rustup.rs (choose the MSVC toolchain)."
Require-Command "node"  "Install Node.js from https://nodejs.org."

# Whisper is a default Cargo feature now (spec/04): cmake + libclang are needed
# for every build, not just a special "whisper" mode. dev-windows.ps1's
# -NoWhisper flag is the escape hatch if a machine can't install these.
if (-not (Get-Command "cmake" -ErrorAction SilentlyContinue)) {
    Write-Host "note: cmake not found — required to compile Whisper (on by default). Install: winget install Kitware.CMake" -ForegroundColor Yellow
    Write-Host "      Or use './scripts/dev-windows.ps1 -NoWhisper' to skip it while hacking on unrelated features." -ForegroundColor Yellow
}

Write-Host "==> Ensuring sqlx-cli is installed..." -ForegroundColor Cyan
if (-not (Get-Command "sqlx" -ErrorAction SilentlyContinue)) {
    cargo install sqlx-cli --no-default-features --features sqlite,rustls
} else {
    Write-Host "sqlx-cli already installed."
}

Write-Host "==> Creating the compile-time dev database + running migrations..." -ForegroundColor Cyan
Push-Location $tauriDir
try {
    # DATABASE_URL / SQLX_OFFLINE come from src-tauri/.env
    sqlx database create
    sqlx migrate run
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Done. Next:" -ForegroundColor Green
Write-Host "  npm install"
Write-Host "  ./scripts/dev-windows.ps1"
