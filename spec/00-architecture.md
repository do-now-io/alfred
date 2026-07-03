# spec/00 — Architecture

## Vue d'ensemble

Alfred est une application desktop macOS construite avec **Tauri v2**. Le backend est en **Rust**, le frontend est une WebView affichant du **React 18 + TypeScript**. La règle de partage des responsabilités est stricte et non négociable :

| Couche | Responsabilité |
|---|---|
| Rust (backend) | Tout ce qui touche l'OS : audio, calendrier, fichiers, SQLite, Keychain, HTTP sortant |
| Frontend (WebView) | Affichage uniquement — aucune logique métier, aucun état persistant |

Le frontend est stateless. Il dérive son état de ce que le backend lui envoie via événements Tauri. Il ne fait aucun appel direct aux APIs externes.

---

## Stack technique

- **Rust** (edition 2021)
- **Tauri v2** — framework desktop, WebView macOS = WebKit
- **React 18** + **TypeScript 5**
- **Zustand** — state management frontend (léger, sans boilerplate)
- **Tailwind CSS v4** — styling
- **CodeMirror 6** — éditeur Markdown dans les notes
- **SQLite** via `sqlx` (runtime async, feature `sqlite`)
- **Tokio** — runtime async Rust

---

## Modèle de processus Tauri v2

```
┌─────────────────────────────────────────────────────┐
│                   macOS Process                     │
│                                                     │
│  ┌──────────────────┐    IPC     ┌───────────────┐  │
│  │   Rust Backend   │◄──────────►│  WebView (UI) │  │
│  │                  │   invoke   │               │  │
│  │  - Calendar sync │   emit     │  React + TS   │  │
│  │  - Audio capture │            │  Zustand      │  │
│  │  - Whisper       │            │  Tailwind     │  │
│  │  - Claude API    │            │               │  │
│  │  - SQLite        │            │               │  │
│  │  - Keychain      │            │               │  │
│  └──────────────────┘            └───────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## Convention IPC

### Commandes (frontend → backend)

Nommage : **snake_case, verbe-nom**.

```typescript
// Appel depuis le frontend
import { invoke } from '@tauri-apps/api/core';
await invoke('get_today_events');
await invoke('start_recording', { source: 'mic_only' });
await invoke('create_todo', { title: '...', source: 'manual' });
```

Toutes les commandes Rust décorées avec `#[tauri::command]` et `async`.

```rust
#[tauri::command]
async fn get_today_events(state: tauri::State<'_, AppState>) -> Result<Vec<CalendarEvent>, String> {
    // ...
}
```

### Événements (backend → frontend)

Nommage : **kebab-case**.

| Événement | Payload | Émetteur |
|---|---|---|
| `recording-status-changed` | `{ status: string, duration_seconds: number }` | Audio module |
| `transcription-progress` | `{ recording_id: string, percent: number }` | Transcription |
| `transcription-complete` | `{ recording_id: string, transcription_id: string }` | Transcription |
| `download-progress` | `{ percent: number, bytes_downloaded: number, total_bytes: number }` | Model download |
| `calendar-synced` | `{ event_count: number }` | Calendar |
| `suggestion-ready` | `{ suggestion_id: string }` | Suggestions |

Émission depuis Rust :
```rust
app.emit("recording-status-changed", serde_json::json!({
    "status": "recording",
    "duration_seconds": 42
})).unwrap();
```

---

## Stockage

### Base de données SQLite

- Chemin : `$APP_DATA_DIR/alfred.db`
- Crate : `sqlx` avec feature `sqlite` + `runtime-tokio`
- Migrations : macro `sqlx::migrate!("migrations/")` au démarrage de l'app
- Fichiers de migration : `src-tauri/migrations/001_initial.sql`, `002_...sql` etc.
- Convention : migrations additive uniquement — jamais `DROP` sans migration de rollback

```rust
// Dans main.rs, au démarrage
sqlx::migrate!("migrations/").run(&pool).await?;
```

### Fichiers audio

- Chemin : `$APP_DATA_DIR/recordings/{recording_id}.wav`
- Supprimés après transcription confirmée en DB

### Modèles Whisper

- Chemin : `$APP_DATA_DIR/models/ggml-{size}.bin`
- Téléchargés à la demande, jamais embarqués dans le binaire

---

## Gestion des secrets — Keychain

Tous les secrets passent par le Keychain macOS via le crate `security-framework`. Jamais en SQLite, jamais en fichier de config.

| Secret | Service | Account |
|---|---|---|
| Clé API Claude | `com.alfred.app` | `claude_api_key` |
| Clé API Vapi | `com.alfred.app` | `vapi_api_key` |
| OAuth Google access token | `com.alfred.app` | `google_oauth_access_token` |
| OAuth Google refresh token | `com.alfred.app` | `google_oauth_refresh_token` |
| Google Client ID | `com.alfred.app` | `google_client_id` |
| Google Client Secret | `com.alfred.app` | `google_client_secret` |

```rust
use security_framework::passwords::{get_generic_password, set_generic_password};

fn save_secret(account: &str, value: &[u8]) -> Result<()> {
    set_generic_password("com.alfred.app", account, value)?;
    Ok(())
}
```

---

## Modèle async

- Tout le backend tourne dans le runtime **Tokio** fourni par Tauri v2
- Toutes les commandes Tauri qui font de l'I/O sont `async`
- Tâches longues (enregistrement audio, transcription) : `tokio::task::spawn` ou `spawn_blocking`
- Les handles de tâches longues sont stockés dans `Arc<Mutex<Option<JoinHandle<...>>>>` dans `tauri::State`

```rust
pub struct AppState {
    pub db: SqlitePool,
    pub recording_handle: Arc<Mutex<Option<JoinHandle<()>>>>,
    pub transcription_tx: mpsc::Sender<TranscriptionJob>,
}
```

---

## Génération des types TypeScript (`ts-rs`)

Les types Rust exposés au frontend sont annotés avec `#[derive(TS)]` du crate `ts-rs`. Cela garantit que les types TypeScript sont toujours en phase avec le backend.

### Workflow

1. Chaque struct/enum exposé dans une commande Tauri dérive `TS` :
```rust
#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    pub start_at: String,
    // ...
}
```

2. Un test dans `src-tauri/src/bindings.rs` exporte tous les types :
```rust
#[cfg(test)]
mod tests {
    #[test]
    fn export_bindings() {
        CalendarEvent::export_all().unwrap();
        Todo::export_all().unwrap();
        // ... tous les types
    }
}
```

3. Commande npm pour régénérer :
```json
// package.json
"scripts": {
  "generate-types": "cd src-tauri && cargo test export_bindings"
}
```

4. Les fichiers générés vivent dans `src/bindings/` et sont **committés** dans le repo.
5. Exécuter `npm run generate-types` après tout changement de type Rust avant de toucher au frontend.

---

## Graphe de dépendances entre modules

```
spec/00 Architecture
    │
    ▼
spec/01 Data Model
    │
    ├──► spec/02 Calendar (no deps)
    ├──► spec/03 Audio Recording (no deps)
    │         │
    │         ▼
    │    spec/04 Transcription
    │         │
    │         ▼
    │    spec/05 AI Brain ◄──── spec/02 Calendar
    │         │
    │    ┌────┴──────────┐
    │    ▼               ▼
    │ spec/06 Todos   spec/08 Suggestions
    │    │               │
    │    └───────┬───────┘
    │            ▼
    ├──► spec/07 Notes
    │
    ├──► spec/09 Phone Calls ◄── spec/08 Suggestions
    │
    ├──► spec/10 Dashboard (agrège tout)
    ├──► spec/11 Settings
    └──► spec/12 Permissions
```

---

## Structure du projet

```
alfred/
├── spec/                         # Ce répertoire — specs
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs
│   │   ├── state.rs              # AppState
│   │   ├── db/
│   │   │   └── mod.rs
│   │   ├── calendar/
│   │   │   └── mod.rs
│   │   ├── audio/
│   │   │   └── mod.rs
│   │   ├── transcription/
│   │   │   └── mod.rs
│   │   ├── ai/
│   │   │   └── mod.rs
│   │   ├── todos/
│   │   │   └── mod.rs
│   │   ├── notes/
│   │   │   └── mod.rs
│   │   ├── suggestions/
│   │   │   └── mod.rs
│   │   └── phone_calls/
│   │       └── mod.rs
│   ├── migrations/
│   │   └── 001_initial.sql
│   ├── capabilities/
│   │   └── default.json          # Tauri v2 capabilities
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── Alfred.entitlements
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── bindings/                 # Types TS générés par ts-rs
│   ├── components/
│   ├── screens/
│   │   ├── Dashboard.tsx
│   │   ├── Notes.tsx
│   │   └── Settings.tsx
│   └── store/                    # Zustand stores
├── package.json
└── vite.config.ts
```
