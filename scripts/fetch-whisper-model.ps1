# Fetch the Whisper `small` model into src-tauri/models/ so it gets bundled
# into the app at build time (tauri.conf.json -> bundle.resources, spec/04).
# Idempotent: skips the download if the file already exists.
param(
    [string]$Size = "small"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Dir = Join-Path $RepoRoot "src-tauri\models"
$File = Join-Path $Dir "ggml-$Size.bin"
$Url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$Size.bin"

New-Item -ItemType Directory -Force -Path $Dir | Out-Null

if (Test-Path $File) {
    Write-Host "✓ Model already present: $File"
    exit 0
}

Write-Host "Downloading Whisper model '$Size' -> $File"
$PartFile = "$File.part"
Invoke-WebRequest -Uri $Url -OutFile $PartFile
Move-Item -Force $PartFile $File
Write-Host "✓ Downloaded: $File"
