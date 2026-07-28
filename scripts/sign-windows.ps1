# Signe les binaires Windows produits par `tauri build` via SSL.com eSigner (HSM
# cloud — pas de clé privée locale, cf. spec/12). Étape CI **après** le build
# (desktop-build.yml), pas un hook `signCommand` de tauri.conf.json : l'intégration
# in-process de Tauri échouait systématiquement en CI ("failed to run powershell",
# 4 configurations différentes testées sans succès) sans qu'on puisse observer la
# vraie cause — signer après coup, en étape CI normale, est plus simple à déboguer
# et c'est la pratique courante pour ce genre de pipeline.
#
# Sans les 4 variables d'env ESIGNER_* (secrets GitHub Actions, absentes en local
# par défaut) : no-op silencieux — les binaires restent NON signés, comme avant.
#
# CodeSignTool (outil officiel SSL.com, cf. https://github.com/SSLcom/CodeSignTool)
# est téléchargé et mis en cache dans .codesigntool/ à la racine du repo (gitignored).
# Nécessite un JRE — `actions/setup-java` en CI ; installer un JDK en local pour tester.

param(
    [Parameter(Mandatory = $true)]
    [string[]]$Paths
)

$ErrorActionPreference = "Stop"

if (-not $env:ESIGNER_USERNAME -or -not $env:ESIGNER_PASSWORD -or -not $env:ESIGNER_TOTP_SECRET -or -not $env:ESIGNER_CREDENTIAL_ID) {
    Write-Host "[sign-windows] Secrets eSigner absents — binaires NON signes (normal en local)." -ForegroundColor Yellow
    exit 0
}

$files = @()
foreach ($pattern in $Paths) {
    $matches = Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue
    if ($matches) { $files += $matches }
}
if ($files.Count -eq 0) {
    Write-Error "[sign-windows] Aucun fichier trouve pour : $($Paths -join ', ')"
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

foreach ($file in $files) {
    $filePath = $file.FullName
    $outDir = $file.DirectoryName
    Write-Host "[sign-windows] Signature de $filePath..." -ForegroundColor Cyan

    Push-Location $toolHome
    try {
        & .\CodeSignTool.bat sign `
            "-input_file_path=$filePath" `
            "-output_dir_path=$outDir" `
            "-username=$env:ESIGNER_USERNAME" `
            "-password=$env:ESIGNER_PASSWORD" `
            "-totp_secret=$env:ESIGNER_TOTP_SECRET" `
            "-credential_id=$env:ESIGNER_CREDENTIAL_ID" `
            "-override=true"
        if ($LASTEXITCODE -ne 0) {
            Write-Error "[sign-windows] CodeSignTool a echoue (exit $LASTEXITCODE) pour $filePath"
        }
    } finally {
        Pop-Location
    }

    Write-Host "[sign-windows] Signe : $filePath" -ForegroundColor Green
}
