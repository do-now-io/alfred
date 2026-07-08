# Deprecated: Whisper is enabled by default now — this is just an alias for
# ./scripts/dev-windows.ps1. Kept so existing muscle-memory / docs keep working.
$ErrorActionPreference = "Stop"
Write-Host "note: dev-whisper-windows.ps1 is deprecated, Whisper is on by default — use ./scripts/dev-windows.ps1" -ForegroundColor Yellow
& (Join-Path $PSScriptRoot "dev-windows.ps1")
