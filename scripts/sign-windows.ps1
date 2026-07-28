# Signe un binaire Windows via SSL.com eSigner (HSM cloud — pas de clé privée
# locale, cf. spec/12). Invoqué automatiquement par Tauri (`bundle.windows.signCommand`
# dans tauri.conf.json, placeholder "%1") sur chaque binaire produit (exe de l'app +
# installeur NSIS/MSI).
#
# Sans les 4 variables d'env ESIGNER_* (secrets GitHub Actions en CI, absentes en
# local par défaut) : no-op silencieux — le build local reste NON signé, comme avant.
#
# CodeSignTool (outil officiel SSL.com, cf. https://github.com/SSLcom/CodeSignTool)
# est téléchargé et mis en cache dans .codesigntool/ à la racine du repo (gitignored).
# Nécessite un JRE — `actions/setup-java` en CI ; installer un JDK en local pour tester.

param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath
)

$ErrorActionPreference = "Stop"

if (-not $env:ESIGNER_USERNAME -or -not $env:ESIGNER_PASSWORD -or -not $env:ESIGNER_TOTP_SECRET -or -not $env:ESIGNER_CREDENTIAL_ID) {
    Write-Host "[sign-windows] Secrets eSigner absents — build NON signe (normal en local)." -ForegroundColor Yellow
    exit 0
}

if (-not (Test-Path $FilePath)) {
    Write-Error "[sign-windows] Fichier introuvable : $FilePath"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$toolDir = Join-Path $repoRoot ".codesigntool"
$toolHome = Join-Path $toolDir "CodeSignTool"

if (-not (Test-Path (Join-Path $toolHome "CodeSignTool.bat"))) {
    Write-Host "[sign-windows] Telechargement de CodeSignTool..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
    $zipPath = Join-Path $toolDir "CodeSignTool.zip"
    Invoke-WebRequest -Uri "https://github.com/SSLcom/CodeSignTool/releases/latest/download/CodeSignTool.zip" -OutFile $zipPath
    Expand-Archive -Path $zipPath -DestinationPath $toolDir -Force
    Remove-Item $zipPath -Force
    $extracted = Get-ChildItem $toolDir -Directory | Where-Object { $_.Name -like "CodeSignTool*" } | Select-Object -First 1
    if (-not $extracted) {
        Write-Error "[sign-windows] Archive CodeSignTool inattendue — dossier extrait introuvable."
    }
    if ($extracted.FullName -ne $toolHome) {
        Rename-Item $extracted.FullName $toolHome
    }
}

$outDir = Split-Path -Parent (Resolve-Path $FilePath)

Push-Location $toolHome
try {
    & .\CodeSignTool.bat sign `
        "-input_file_path=$FilePath" `
        "-output_dir_path=$outDir" `
        "-username=$env:ESIGNER_USERNAME" `
        "-password=$env:ESIGNER_PASSWORD" `
        "-totp_secret=$env:ESIGNER_TOTP_SECRET" `
        "-credential_id=$env:ESIGNER_CREDENTIAL_ID" `
        "-override=true"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "[sign-windows] CodeSignTool a echoue (exit $LASTEXITCODE) pour $FilePath"
    }
} finally {
    Pop-Location
}

Write-Host "[sign-windows] Signe : $FilePath" -ForegroundColor Green
