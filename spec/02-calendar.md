# spec/02 — Calendar Integration

> ⛔ **HORS V1 — retiré.** Le calendrier (et toute la connexion Google / OAuth)
> est hors périmètre v1. Contenu conservé comme référence pour une phase future.
> Voir `spec/README.md`.

> **Décision fixée : D5**
> Port OAuth local → port aléatoire (0) assigné par l'OS, stocké dans `Mutex<u16>`

---

## Vue d'ensemble

Deux sources de calendrier synchronisées dans la table `calendar_events` :
- **Google Calendar** via REST API + OAuth2
- **Apple Calendar** via AppleScript (`osascript`)

La sync est pull-based (Alfred interroge les sources, pas l'inverse). Aucun webhook.

---

## Google Calendar

### Prérequis — Google Cloud Console

1. Créer un projet dans Google Cloud Console
2. Activer l'API **Google Calendar API**
3. Créer des identifiants OAuth 2.0 de type **"Desktop application"** (pas "Web application")
   - Ce type autorise `http://127.0.0.1` comme redirect URI sans l'enregistrer explicitement
   - Google fait une exception pour le loopback (RFC 8252) : tout port sur 127.0.0.1 est accepté
4. Télécharger le Client ID et Client Secret → stockés en Keychain (voir spec/00)

### Flow OAuth2 — implémentation exacte

```
1. L'utilisateur clique "Connecter Google Calendar" dans Settings

2. Rust : ouvrir un serveur HTTP local sur port 0
   let listener = TcpListener::bind("127.0.0.1:0").await?;
   let port = listener.local_addr()?.port();
   // Stocker port dans Arc<Mutex<u16>> dans AppState

3. Rust : construire l'URL d'autorisation
   https://accounts.google.com/o/oauth2/v2/auth
     ?client_id={CLIENT_ID}
     &redirect_uri=http://127.0.0.1:{port}/callback
     &response_type=code
     &scope=https://www.googleapis.com/auth/calendar.readonly
     &access_type=offline
     &prompt=consent

4. Rust : ouvrir l'URL dans le navigateur système
   tauri::api::shell::open(&app_handle, url, None)?;

5. Rust : attendre la requête de callback sur le serveur local
   let request = listener.accept().await?;
   // Parser ?code=xxx depuis la query string

6. Rust : échanger le code contre des tokens
   POST https://oauth2.googleapis.com/token
   Body: code=xxx&client_id=...&client_secret=...
         &redirect_uri=http://127.0.0.1:{port}/callback
         &grant_type=authorization_code
   Réponse: { access_token, refresh_token, expires_in }

7. Rust : stocker en Keychain
   google_oauth_access_token = access_token
   google_oauth_refresh_token = refresh_token
   google_oauth_expires_at = now + expires_in (en config SQLite)

8. Fermer le serveur local
```

Le serveur local n'existe que pendant le flow OAuth. Il est fermé après réception du code (ou timeout de 5 minutes).

### Refresh automatique

Avant chaque appel à l'API Google Calendar :
```
if expires_at - now < 5 minutes:
    POST https://oauth2.googleapis.com/token
    Body: refresh_token=...&client_id=...&client_secret=...
          &grant_type=refresh_token
    → Mettre à jour access_token + expires_at en Keychain
```

Crate à utiliser : `reqwest` avec feature `json`.

### Appel API

```
GET https://www.googleapis.com/calendar/v3/calendars/primary/events
  ?timeMin={aujourd'hui 00:00 UTC}
  &timeMax={aujourd'hui + 7 jours 23:59 UTC}
  &singleEvents=true
  &orderBy=startTime
  &maxResults=250
Authorization: Bearer {access_token}
```

Gérer la pagination : si `nextPageToken` présent dans la réponse, enchaîner les appels avec `pageToken={token}`.

### Mapping vers `calendar_events`

```
source = 'google'
external_id = event.id
title = event.summary
start_at = event.start.dateTime (ou event.start.date si all_day)
end_at = event.end.dateTime
location = event.location
description = event.description
attendees = JSON.stringify(event.attendees.map(a => a.email))
all_day = event.start.date != null ? 1 : 0
```

Upsert par `(source, external_id)` :
```sql
INSERT INTO calendar_events (...) VALUES (...)
ON CONFLICT (source, external_id) DO UPDATE SET
  title = excluded.title,
  start_at = excluded.start_at,
  ...
  last_synced_at = excluded.last_synced_at;
```

---

## Apple Calendar

### Approche — AppleScript via `osascript`

On interroge Calendar.app via AppleScript. Cela ne nécessite pas de SDK tiers ni d'accès direct EventKit.

**Entitlement requis** : `com.apple.security.automation.apple-events` (Hardened Runtime)

⚠️ Ne pas confondre avec `com.apple.security.personal-information.calendars` qui est pour EventKit (API programmatique Swift/ObjC) — ce n'est pas ce qu'on utilise.

**Info.plist requis** : `NSAppleEventsUsageDescription` avec une description explicite.

### Script AppleScript

```applescript
set startDate to current date
set endDate to startDate + (7 * days)

set eventList to {}
tell application "Calendar"
    repeat with cal in calendars
        set theEvents to (every event of cal whose start date ≥ startDate and start date ≤ endDate)
        repeat with ev in theEvents
            set evData to {|id|: uid of ev, |title|: summary of ev, |start|: start date of ev as string, |end|: end date of ev as string, |location|: location of ev, |description|: description of ev}
            set end of eventList to evData
        end repeat
    end repeat
end tell
return eventList
```

Exécution depuis Rust :
```rust
let output = std::process::Command::new("osascript")
    .arg("-e")
    .arg(APPLESCRIPT_TEMPLATE)
    .output()?;
let stdout = String::from_utf8(output.stdout)?;
// Parser la sortie AppleScript
```

La sortie AppleScript est parsée avec un parser dédié (format liste AppleScript → structs Rust).

### Mapping vers `calendar_events`

```
source = 'apple'
external_id = uid de l'événement AppleScript
title = summary
start_at = date parsée en ISO 8601
end_at = date parsée en ISO 8601
location = location (peut être vide)
description = description (peut être vide)
```

---

## Sync

### Déclencheurs

1. Au lancement de l'application
2. Toutes les 15 minutes via `tokio::time::interval`

```rust
let mut interval = tokio::time::interval(Duration::from_secs(15 * 60));
loop {
    interval.tick().await;
    sync_all_calendars(&state).await;
}
```

### Comportement pendant le sleep macOS

Quand le Mac dort, Tokio est suspendu. L'intervalle ne se déclenche pas exactement à 15 min — il se déclenche au réveil du Mac. Ce comportement est acceptable pour v1. Pas de mécanisme de rattrapage.

### Ordre de sync

1. Apple Calendar en premier (plus rapide, pas d'I/O réseau)
2. Google Calendar ensuite (réseau)

Les deux s'exécutent en séquence dans la même tâche Tokio pour éviter les race conditions sur la DB.

---

## Commandes Tauri exposées

```rust
#[tauri::command]
async fn get_today_events(state: State<AppState>) -> Result<Vec<CalendarEvent>, String>

#[tauri::command]
async fn get_week_events(state: State<AppState>) -> Result<Vec<CalendarEvent>, String>

#[tauri::command]
async fn trigger_calendar_sync(state: State<AppState>) -> Result<(), String>

#[tauri::command]
async fn get_calendar_auth_status(state: State<AppState>) -> Result<CalendarAuthStatus, String>
// CalendarAuthStatus: { google: "connected" | "disconnected", apple: "available" | "permission_denied" }

#[tauri::command]
async fn start_google_oauth(state: State<AppState>, app: AppHandle) -> Result<(), String>
```

### Événement émis après sync

```
"calendar-synced" → { event_count: number, synced_at: string }
```
