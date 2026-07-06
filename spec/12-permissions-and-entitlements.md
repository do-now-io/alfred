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
- **Windows** : certificat de **signature de code** (Authenticode) pour éviter les
  avertissements SmartScreen.

## Note bug

Aligner le label du launch-at-login macOS (`io.alfred.app`) sur l'identifiant
`com.alfred.app` (spec/11).

## Hors v1 / plus tard

Distribution **App Store** (sandbox `true`, migration EventKit — dette technique
documentée dans l'ancienne version), entitlements calendrier (Apple/Google).
