# Alfred — run the app in dev mode on Windows.
#
# Whisper (local transcription) is ON by default now (spec/04) — whisper-rs
# builds whisper.cpp via CMake and generates bindings via bindgen, which needs
# libclang.dll located through LIBCLANG_PATH. This script discovers libclang
# and then runs `tauri dev`.
#
# Prerequisites (see README):
#   - CMake            (winget install Kitware.CMake)
#   - MSVC C++ build tools
#   - libclang.dll     (e.g. `pip install --user libclang`, or LLVM)
#
# Pass -NoWhisper to skip all of that while hacking on unrelated features on a
# machine without those prerequisites (recording still works, no transcription).
#
# Run from the repo root:  ./scripts/dev-windows.ps1

param(
    [switch]$NoWhisper
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Find-LibclangDir {
    # 1. Already set and valid
    if ($env:LIBCLANG_PATH -and (Test-Path (Join-Path $env:LIBCLANG_PATH "libclang.dll"))) {
        return $env:LIBCLANG_PATH
    }
    # 2. Common candidate locations
    $candidates = @(
        "C:\Users\$env:USERNAME\libclang\bin",
        "C:\Program Files\LLVM\bin"
    )
    # 3. pip's `libclang` package (clang/native/libclang.dll)
    if (Get-Command python -ErrorAction SilentlyContinue) {
        try {
            $site = python -c "import site; print(site.getusersitepackages())" 2>$null
            if ($site) { $candidates += (Join-Path $site "clang\native") }
        } catch {}
    }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path (Join-Path $c "libclang.dll"))) { return $c }
    }
    return $null
}

Push-Location $repoRoot
try {
    if ($NoWhisper) {
        Write-Host "Whisper disabled for this run (-NoWhisper) — recording works, no transcription." -ForegroundColor Yellow
        npm run tauri -- dev --no-default-features
    } else {
        $libclang = Find-LibclangDir
        if (-not $libclang) {
            Write-Error "Could not find libclang.dll. Install it with 'pip install --user libclang' or LLVM, or set LIBCLANG_PATH. (Or pass -NoWhisper to skip Whisper for this run.)"
        }
        $env:LIBCLANG_PATH = $libclang
        Write-Host "LIBCLANG_PATH = $libclang" -ForegroundColor Cyan

        if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
            Write-Error "cmake not found. Install it: winget install Kitware.CMake (or pass -NoWhisper to skip Whisper for this run)."
        }

        npm run tauri:dev
    }
} finally {
    Pop-Location
}
