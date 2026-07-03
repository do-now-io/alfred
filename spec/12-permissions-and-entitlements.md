# spec/12 — macOS Permissions & Entitlements

> **Décision fixée : D3**
> Distribution directe (pas App Store) pour v1 → sandbox désactivé (`com.apple.security.app-sandbox = false`)

---

## Fichier Alfred.entitlements

Chemin : `src-tauri/Alfred.entitlements`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
    "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- Hardened Runtime activé pour la signature, sandbox DÉSACTIVÉ -->
    <key>com.apple.security.app-sandbox</key>
    <false/>

    <!-- Microphone -->
    <key>com.apple.security.device.audio-input</key>
    <true/>

    <!-- AppleScript → Calendar.app -->
    <!-- NOTE: NE PAS utiliser com.apple.security.personal-information.calendars
         qui est pour EventKit (API Swift). Pour osascript, c'est apple-events. -->
    <key>com.apple.security.automation.apple-events</key>
    <true/>

    <!-- HTTP sortant (Google APIs, Claude API, Vapi, HuggingFace) -->
    <key>com.apple.security.network.client</key>
    <true/>

    <!-- ScreenCaptureKit (audio système) — activer si source mixed/system_only implémentée -->
    <!-- Laisser commenté pour la Phase 1 -->
    <!-- <key>com.apple.security.screen-capture</key> -->
    <!-- <true/> -->
</dict>
</plist>
```

---

## Info.plist — Usage Descriptions

Ces chaînes apparaissent dans le dialogue de permission macOS présenté à l'utilisateur.

Chemin : `src-tauri/Info.plist` (ou fusionné dans `tauri.conf.json` `bundle.macOS.infoPlist`)

```xml
<!-- Microphone -->
<key>NSMicrophoneUsageDescription</key>
<string>Alfred utilise le microphone pour enregistrer des notes vocales et transcrire vos réunions localement sur votre Mac.</string>

<!-- AppleScript → Calendar -->
<key>NSAppleEventsUsageDescription</key>
<string>Alfred accède à votre calendrier pour afficher vos événements de la journée et de la semaine.</string>

<!-- ScreenCaptureKit (audio système) — décommenter en Phase 5 -->
<!--
<key>NSScreenCaptureUsageDescription</key>
<string>Alfred capture l'audio système pour transcrire vos appels et réunions en ligne.</string>
-->
```

---

## Tauri v2 Capabilities

Fichier : `src-tauri/capabilities/default.json`

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Alfred default capabilities",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "shell:allow-open",
    "core:path:default",
    "core:app:default"
  ]
}
```

`shell:allow-open` est requis pour ouvrir l'URL OAuth dans le navigateur système (`tauri::api::shell::open`).

---

## Signature et notarisation

Pour la distribution directe (hors App Store), l'app doit être :
1. **Signée** avec un certificat "Developer ID Application" (Apple Developer Program requis)
2. **Notarisée** par Apple (upload automatique via `xcrun notarytool`)
3. **Stapled** (ticket de notarisation attaché au bundle)

Tauri v2 supporte la signature et la notarisation dans son pipeline de build :
```json
// tauri.conf.json
"bundle": {
  "macOS": {
    "signingIdentity": "Developer ID Application: Tanguy Charon (XXXXXXXXXX)",
    "notarizationCredentials": {
      "appleId": "tanguy.charon@do-now.io",
      "teamId": "XXXXXXXXXX"
    }
  }
}
```

---

## Permissions demandées au runtime

Les permissions TCC (Transparency, Consent, and Control) sont demandées **à la première utilisation**, pas au lancement.

| Permission | Quand demandée | Si refusée |
|---|---|---|
| Microphone | Premier clic sur "Enregistrer" | Bouton Enregistrer désactivé avec lien vers Paramètres Système |
| Accès aux apps (AppleScript Calendar) | Premier sync Apple Calendar | Sync Apple Calendar désactivée |
| Capture d'écran (ScreenCaptureKit) | Sélection de source "Audio système" | Option désactivée avec message |

En cas de refus, afficher un lien direct vers Paramètres Système :
```rust
tauri::api::shell::open(&app, "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone", None)?;
```

---

## Note de dette technique — App Store

Si une distribution App Store est envisagée dans une version future :

1. `com.apple.security.app-sandbox` doit être `true`
2. `osascript` ne fonctionne pas sous sandbox → migrer vers EventKit (API Swift via FFI ou helper)
3. Le stockage dans `$APP_DATA_DIR` reste valide sous sandbox
4. Les entitlements sandbox requis : `com.apple.security.files.user-selected.read-write`

Cette migration est estimée à ~2 semaines de travail. Ne pas l'engager sans décision business préalable.

---

## Checklist de build

Vérifier avant chaque release :

- [ ] `Alfred.entitlements` correspond aux fonctionnalités activées
- [ ] `NSMicrophoneUsageDescription` défini
- [ ] `NSAppleEventsUsageDescription` défini
- [ ] App signée avec "Developer ID Application"
- [ ] App notarisée et stapled
- [ ] Test sur machine sans Xcode installé (vérifie les deps dynamiques)
- [ ] Test sur macOS 13 (version minimale supportée)
