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
# Embarque son propre JDK (jdk-11.0.2/) — aucun Java système requis.

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
    New-Item -ItemType Directory -Force -Path $toolHome | Out-Null
    # Le nom de l'archive est versionne (ex. CodeSignTool-v1.3.2-windows.zip) — pas
    # de nom stable "latest/download/CodeSignTool.zip" (404). On resout l'asset via
    # l'API GitHub : d'abord la variante "-windows.zip" si presente, sinon le zip
    # generique. L'archive n'a PAS de sous-dossier "CodeSignTool/" — CodeSignTool.bat,
    # jar/ et son propre JDK embarque (jdk-11.0.2/, pas besoin de Java installe) sont
    # directement a la racine du zip.
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/SSLcom/CodeSignTool/releases/latest" -Headers @{ "User-Agent" = "alfred-sign-windows" }
    $asset = $release.assets | Where-Object { $_.name -like "*-windows.zip" } | Select-Object -First 1
    if (-not $asset) {
        $asset = $release.assets | Where-Object { $_.name -like "*.zip" } | Select-Object -First 1
    }
    if (-not $asset) {
        Write-Error "[sign-windows] Aucune archive .zip trouvee dans la derniere release CodeSignTool."
    }
    $zipPath = Join-Path $toolDir $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath
    Expand-Archive -Path $zipPath -DestinationPath $toolHome -Force
    Remove-Item $zipPath -Force
    if (-not (Test-Path (Join-Path $toolHome "CodeSignTool.bat"))) {
        Write-Error "[sign-windows] Archive CodeSignTool inattendue — CodeSignTool.bat introuvable apres extraction."
    }
}

foreach ($file in $files) {
    $filePath = $file.FullName
    $outDir = $file.DirectoryName
    Write-Host "[sign-windows] Signature de $filePath..." -ForegroundColor Cyan

    # CodeSignTool.bat renvoie exit code 0 MEME en echec (testes : format non
    # supporte, identifiants invalides — dans les deux cas exit=0, juste une ligne
    # "Error: ..." dans la sortie). Se fier au SEUL signal fiable : le hash du
    # fichier a-t-il change ? Une signature reussie reecrit le fichier.
    $hashBefore = (Get-FileHash -Path $filePath -Algorithm SHA256).Hash
    $output = ""

    Push-Location $toolHome
    try {
        $output = & .\CodeSignTool.bat sign `
            "-input_file_path=$filePath" `
            "-output_dir_path=$outDir" `
            "-username=$env:ESIGNER_USERNAME" `
            "-password=$env:ESIGNER_PASSWORD" `
            "-totp_secret=$env:ESIGNER_TOTP_SECRET" `
            "-credential_id=$env:ESIGNER_CREDENTIAL_ID" `
            "-override=true" 2>&1 | Out-String
    } finally {
        Pop-Location
    }
    Write-Host $output

    $hashAfter = (Get-FileHash -Path $filePath -Algorithm SHA256).Hash
    if ($hashAfter -eq $hashBefore -or $output -match "(?im)^Error:") {
        Write-Error "[sign-windows] CodeSignTool n'a pas signe $filePath (exit $LASTEXITCODE, fichier inchange ou erreur dans la sortie ci-dessus)"
    }

    Write-Host "[sign-windows] Signe : $filePath" -ForegroundColor Green
}
