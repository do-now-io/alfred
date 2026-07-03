# spec/11 — Settings

---

## Écran Settings — Layout

L'écran Settings est divisé en sections. Chaque section est un groupe de paramètres liés.

```
┌──────────────────────────────────────────────────────┐
│  ⚙️ Paramètres                                        │
│                                                      │
│  ── APIs ─────────────────────────────────────────── │
│  Clé API Claude         [••••••••••] [Tester]        │
│  Clé API Vapi           [••••••••••] [Tester]        │
│  ID numéro Vapi         [phone_num_id_xxx]           │
│  Clé Google Places      [••••••••••]                 │
│                                                      │
│  ── Calendrier ───────────────────────────────────── │
│  Google Calendar        [Connecté ✓] [Déconnecter]  │
│                          ou [Connecter Google]       │
│  Apple Calendar         [Disponible ✓]               │
│  Intervalle de sync     [15] minutes                 │
│                                                      │
│  ── Transcription ────────────────────────────────── │
│  Modèle Whisper         [small ▾]                    │
│  Langue                 [Auto-détection ▾]           │
│                                                      │
│  ── Enregistrement ───────────────────────────────── │
│  Source audio           [Microphone uniquement ▾]    │
│                                                      │
│  ── Système ──────────────────────────────────────── │
│  Lancer au démarrage    [☐]                          │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## Tableau des paramètres

| Clé | Label UI | Défaut | Stockage | Validation |
|---|---|---|---|---|
| `claude_api_key` | Clé API Claude | — | Keychain | Non-vide, test avec appel `/v1/messages` minimal |
| `vapi_api_key` | Clé API Vapi | — | Keychain | Non-vide |
| `vapi_phone_number_id` | ID numéro Vapi | — | SQLite config | Non-vide |
| `google_places_api_key` | Clé Google Places | — | Keychain | Non-vide |
| `google_oauth_access_token` | *(interne)* | — | Keychain | Géré par flow OAuth |
| `google_oauth_refresh_token` | *(interne)* | — | Keychain | Géré par flow OAuth |
| `whisper_model` | Modèle Whisper | `small` | SQLite config | Enum: `tiny`, `base`, `small`, `medium` |
| `language_hint` | Langue | `auto` | SQLite config | Enum: `auto`, `fr`, `en`, `es`, `de` |
| `recording_source` | Source audio | `mic_only` | SQLite config | Enum: `mic_only`, `system_only`, `mixed` |
| `calendar_sync_interval_min` | Intervalle sync | `15` | SQLite config | Integer, 5–60 |
| `launch_at_login` | Lancer au démarrage | `false` | LaunchAgent plist | Boolean |
| `vapi_phone_number_id` | ID numéro Vapi | — | SQLite config | Non-vide |

---

## Validation des clés API

### Claude API

Tester avec un appel minimal au clic sur [Tester] :

```rust
async fn test_claude_api_key(key: &str) -> Result<(), String> {
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&serde_json::json!({
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "Hi"}]
        }))
        .send()
        .await?;

    if response.status() == 401 {
        Err("Clé API invalide".to_string())
    } else {
        Ok(())
    }
}
```

### Vapi API

```rust
async fn test_vapi_api_key(key: &str) -> Result<(), String> {
    let response = client
        .get("https://api.vapi.ai/phone-number")
        .bearer_auth(key)
        .send()
        .await?;

    if response.status() == 401 {
        Err("Clé API Vapi invalide".to_string())
    } else {
        Ok(())
    }
}
```

---

## Lancer au démarrage — LaunchAgent

Sur macOS, "lancer au démarrage" est géré via un fichier plist dans `~/Library/LaunchAgents/` :

```xml
<!-- ~/Library/LaunchAgents/io.alfred.app.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ...>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>io.alfred.app</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Applications/Alfred.app/Contents/MacOS/alfred</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

Activer :
```rust
std::fs::write(&plist_path, PLIST_CONTENT)?;
std::process::Command::new("launchctl")
    .args(["load", plist_path.to_str().unwrap()])
    .output()?;
```

Désactiver :
```rust
std::process::Command::new("launchctl")
    .args(["unload", plist_path.to_str().unwrap()])
    .output()?;
std::fs::remove_file(&plist_path)?;
```

---

## Changement de modèle Whisper

Quand l'utilisateur change le modèle Whisper dans les Settings :
1. Sauvegarder la nouvelle valeur dans `config.whisper_model`
2. Vérifier si le fichier `ggml-{nouveau_modèle}.bin` existe dans `$APP_DATA_DIR/models/`
3. Si non → déclencher automatiquement le téléchargement (voir spec/04)
4. Afficher un indicateur de téléchargement dans les Settings pendant le download

---

## Commandes Tauri

```rust
#[tauri::command]
async fn get_settings(state: State<AppState>) -> Result<Settings, String>

#[tauri::command]
async fn update_setting(
    key: String,
    value: String,
    state: State<AppState>,
) -> Result<(), String>

#[tauri::command]
async fn test_api_key(
    service: String,  // "claude" | "vapi"
    state: State<AppState>,
) -> Result<(), String>

#[tauri::command]
async fn set_launch_at_login(enabled: bool) -> Result<(), String>

#[tauri::command]
async fn get_launch_at_login() -> Result<bool, String>
```
