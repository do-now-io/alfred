# spec/12 — Permissions & Entitlements (cross-platform)

> **Statut v1 :** réconcilier — Windows + macOS ; micro + **capture audio système** ;
> retirer apple-events / calendrier.

## macOS — `Alfred.entitlements`

Sandbox **désactivé** (distribution directe hors App Store). Entitlements v1 :
- `com.apple.security.app-sandbox` = `false`
- `com.apple.security.device.audio-input` = `true` (micro)
- `com.apple.security.network.client` = `true` (HTTP : Claude / proxy AlfredIA / HuggingFace)
- `com.apple.security.files.user-selected.read-write` = `true` (vault choisi par l'utilisateur)
- **Retirer** `com.apple.security.automation.apple-events` (était pour Calendar AppleScript — hors v1).

## macOS — `Info.plist` (usage descriptions)

- **Garder** `NSMicrophoneUsageDescription`.
- **Ajouter** `NSScreenCaptureUsageDescription` — l'audio système via ScreenCaptureKit
  (spec/03) déclenche la permission « Enregistrement de l'écran » (accordée dans
  Réglages Système → Confidentialité). App non-sandboxée → pas d'entitlement dédié,
  la usage description suffit à afficher le prompt. Le **helper Swift** doit aussi la porter.
- **Retirer** `NSAppleEventsUsageDescription` + `NSCalendarsUsageDescription` (calendrier hors v1).

## Windows

- Pas d'entitlements. Permissions au runtime :
  - **Micro** : réglage de confidentialité Windows (Réglages → Confidentialité → Micro) ; capture WASAPI.
  - **Audio système** : WASAPI **loopback** — pas de permission spécifique.
- **WebView2 runtime** requis (spec/00).

## Tauri v2 — `capabilities/default.json`

`core:default`, `shell:allow-open`, `opener:default`, `dialog:allow-open`
(`dialog` pour le picker de vault ; `shell`/`opener` pour ouvrir les liens externes —
loopback AlfredIA / Stripe).

## Permissions demandées au runtime

| Permission | Quand | Si refusée |
|---|---|---|
| Micro | 1er enregistrement (test à l'onboarding, spec/13) | Enregistrement désactivé + lien vers Réglages Système |
| Capture d'écran (macOS, audio système) | 1ère source « audio système » | Option désactivée + message |

## Signature & distribution

- **macOS** : « Developer ID Application » + **notarisation** + staple (hors App Store).
  **Reste à faire.**
- **Windows** : ✅ **fait, vérifié en réel.** Certificat OV **DONOW** (SSL.com, validé
  Kbis) signé via **eSigner** — signature **cloud HSM**, la clé privée ne quitte
  jamais SSL.com (pas de token USB/fichier `.pfx`, requis depuis juin 2023 par le
  CA/Browser Forum pour tout certificat de signature de code).

  **Étape CI à part** (`scripts/sign-windows.ps1`, appelé juste après `tauri build`
  dans `desktop-build.yml`) plutôt qu'un hook `bundle.windows.signCommand` de
  `tauri.conf.json` — abandonné après plusieurs échecs opaques en CI (`failed to run
  powershell`, identique sur 4 configurations différentes, sans log exploitable ;
  probable bug/mauvaise remontée d'erreur du hook interne de Tauri). Le script
  télécharge/appelle `CodeSignTool` (outil officiel SSL.com, résolution dynamique de
  l'asset via l'API GitHub releases — embarque son propre JDK) sur chaque binaire
  produit (exe app + installeur NSIS/MSI), **dans un dossier de staging séparé**
  (CodeSignTool refuse de signer si `output_dir_path` == le dossier du fichier
  d'entrée) puis écrase l'original. Détection d'échec par **hash SHA256 avant/après**
  plutôt que le code de sortie : `CodeSignTool.bat` renvoie **exit 0 même en échec**
  (testé avec identifiants invalides et format non supporté).

  Piloté par 4 secrets GitHub Actions (`ESIGNER_USERNAME`/`PASSWORD`/`TOTP_SECRET`/
  `CREDENTIAL_ID`) — **no-op silencieux** si absents (build local non signé,
  comportement inchangé pour les contributeurs sans accès aux secrets). Avec un
  certificat **OV** (pas EV), SmartScreen affiche encore un avertissement — **vérifié**
  sur l'installeur `v0.2.8` : l'éditeur affiché est bien **« DONOW »** (plus « Unknown
  publisher ») ; l'avertissement lui-même disparaîtra progressivement avec
  l'accumulation de réputation (téléchargements/exécutions) — compromis de coût
  accepté (décision explicite, pas un certificat EV).

## Note bug — ✅ fait

Label du launch-at-login macOS aligné sur l'identifiant `com.alfred.app`
(était `io.alfred.app`, spec/11).

## Hors v1 / plus tard

Distribution **App Store** (sandbox `true`, migration EventKit — dette technique
documentée dans l'ancienne version), entitlements calendrier (Apple/Google).
