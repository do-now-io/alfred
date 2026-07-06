# Alfred — run the app in dev mode on Windows.
# Whisper transcription is disabled (macOS-only for now); recording still works.
#
# Run from the repo root:  ./scripts/dev-windows.ps1

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    npm run tauri:dev
} finally {
    Pop-Location
}
