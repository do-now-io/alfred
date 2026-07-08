# Build Alfred for Windows with Whisper local transcription, `small` model
# bundled (spec/04). Prerequisites: CMake, MSVC C++ build tools, libclang.dll
# (see README).
#
# Run from the repo root:  ./scripts/build-windows.ps1

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Find-LibclangDir {
    if ($env:LIBCLANG_PATH -and (Test-Path (Join-Path $env:LIBCLANG_PATH "libclang.dll"))) {
        return $env:LIBCLANG_PATH
    }
    $candidates = @(
        "C:\Users\$env:USERNAME\libclang\bin",
        "C:\Program Files\LLVM\bin"
    )
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

$libclang = Find-LibclangDir
if (-not $libclang) {
    Write-Error "Could not find libclang.dll. Install it with 'pip install --user libclang' or LLVM, or set LIBCLANG_PATH."
}
$env:LIBCLANG_PATH = $libclang
Write-Host "LIBCLANG_PATH = $libclang" -ForegroundColor Cyan

if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
    Write-Error "cmake not found. Install it: winget install Kitware.CMake"
}

Push-Location $repoRoot
try {
    Write-Host "==> Fetching the Whisper 'small' model (bundled into the installer)..." -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot "fetch-whisper-model.ps1")

    Write-Host "==> Building (tauri build)..." -ForegroundColor Cyan
    npm run tauri -- build
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "✓ Built: src-tauri\target\release\bundle\ (msi\ and/or nsis\)" -ForegroundColor Green
