# spec/05 — AI Brain (Claude API)

---

## Vue d'ensemble

Claude est utilisé pour trois tâches distinctes. Chaque tâche a un prompt défini, un budget de tokens, et une stratégie de coût.

| Tâche | Déclencheur | Prompt caching | Budget tokens |
|---|---|---|---|
| Extraction de todos | Après chaque transcription | Oui (system prompt) | ~2K output |
| Synthèse hebdomadaire | Bouton ou lundi matin | Non | ~1K output |
| Génération de suggestions | Après sync calendrier | Non | ~500 output |

Crate : `reqwest` avec feature `json`. Pas de SDK Anthropic officiel Rust — appels HTTP directs.

**Modèle :** `claude-sonnet-4-6`

---

## Authentification

La clé API est lue depuis le Keychain à chaque appel (ne pas la mettre en cache en mémoire) :

```rust
let api_key = get_keychain_secret("claude_api_key")?;

let response = client
    .post("https://api.anthropic.com/v1/messages")
    .header("x-api-key", &api_key)
    .header("anthropic-version", "2023-06-01")
    .header("content-type", "application/json")
    .json(&body)
    .send()
    .await?;
```

---

## Retry — politique

```
- Codes retriables : 529 (overloaded), 500, 502, 503, 504
- Codes non retriables : 400, 401, 403, 404, 422
- Max tentatives : 3
- Backoff : 1s → 2s → 4s (exponentiel)
- Sur 401 : émettre l'événement "claude-auth-error" → l'UI propose de ressaisir la clé API
```

```rust
async fn call_claude_with_retry(body: &serde_json::Value) -> Result<serde_json::Value> {
    let mut attempt = 0;
    loop {
        let result = call_claude(body).await;
        match result {
            Ok(r) => return Ok(r),
            Err(e) if e.is_retryable() && attempt < 3 => {
                tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}
```

---

## Tâche 1 — Extraction de todos depuis transcription

### Déclencheur

Automatiquement après chaque `transcription-complete`. Claude analyse le texte et retourne les todos détectés.

### Prompt caching

Le system prompt est identique à chaque appel → il est mis en cache via `cache_control`.

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 2048,
  "system": [
    {
      "type": "text",
      "text": "Tu es un assistant personnel qui extrait des tâches à faire à partir de transcriptions de réunions ou de notes vocales. Analyse le texte fourni et identifie toutes les actions à réaliser, engagements pris, ou choses à ne pas oublier. Retourne UNIQUEMENT un objet JSON valide avec le format suivant, sans aucun texte autour :\n{\"todos\": [{\"title\": \"...\", \"description\": \"...\", \"due_date_hint\": \"...\"}]}\nLe due_date_hint peut être une date ISO (2026-06-15), une expression relative (demain, cette semaine, jeudi), ou null si non mentionné. Si aucune tâche n'est trouvée, retourner {\"todos\": []}.",
      "cache_control": {"type": "ephemeral"}
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "Transcription :\n\n{RAW_TEXT}"
    }
  ]
}
```

### Parsing et déduplication

```rust
let todos: Vec<TodoExtract> = serde_json::from_str(&response["todos"].to_string())?;
for todo in todos {
    let title_hash = sha256(&todo.title);
    // Vérifier si un todo avec (source=transcription, source_id=transcription_id, title_hash) existe déjà
    let exists = db.fetch_one(
        "SELECT id FROM todos WHERE source='transcription' AND source_id=? AND title_hash=?",
        (transcription_id, title_hash)
    ).await.is_ok();

    if !exists {
        create_todo(&todo, "transcription", transcription_id).await?;
    }
}
```

Ajouter une colonne `title_hash TEXT` à la table `todos` dans une migration.

---

## Tâche 2 — Synthèse hebdomadaire

### Déclencheurs

1. **Bouton "Synthèse de la semaine"** dans le dashboard (déclenché manuellement à tout moment)
2. **Automatique** : premier lancement de l'app le lundi entre 6h et 12h heure locale

Détection du lundi matin :
```rust
let now = chrono::Local::now();
let last_run: NaiveDate = get_config("weekly_synthesis_last_run")
    .and_then(|s| NaiveDate::parse_from_str(&s, "%Y-%m-%d").ok())
    .unwrap_or(NaiveDate::MIN);

if now.weekday() == Weekday::Mon && now.hour() < 12 && last_run < now.date_naive() {
    generate_weekly_synthesis().await?;
    set_config("weekly_synthesis_last_run", &now.format("%Y-%m-%d").to_string()).await?;
}
```

### Prompt

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": "Voici mes événements des 7 prochains jours et mes tâches en cours. Fais une synthèse concise en Markdown de ce à quoi je dois faire attention cette semaine. Identifie les priorités, les conflits potentiels, et les choses qui nécessitent une action proactive (réservations, préparations, etc.).\n\n## Événements\n{EVENTS_JSON}\n\n## Tâches\n{TODOS_JSON}"
    }
  ]
}
```

### Mise en cache du résultat

Le résultat est stocké dans `config` :
```sql
UPDATE config SET value = ? WHERE key = 'weekly_synthesis_text';
UPDATE config SET value = ? WHERE key = 'weekly_synthesis_last_run';
```

Le frontend affiche le texte mis en cache. Un indicateur "Généré le {date}" est affiché à côté du bouton.

---

## Tâche 3 — Génération de suggestions

### Déclencheur

Après chaque sync calendrier complète ET après chaque nouvelle transcription.

### Règles heuristiques (avant d'appeler Claude)

Claude n'est appelé que si au moins une règle heuristique se déclenche :

```rust
fn evaluate_heuristics(events: &[CalendarEvent], todos: &[Todo]) -> Vec<HeuristicMatch> {
    let mut matches = vec![];

    for event in events {
        // LUNCH_DINNER_NO_LOCATION
        let title_lower = event.title.to_lowercase();
        if (title_lower.contains("lunch") || title_lower.contains("dinner")
            || title_lower.contains("déjeuner") || title_lower.contains("dîner"))
            && event.location.as_deref().unwrap_or("").is_empty()
        {
            matches.push(HeuristicMatch::LunchDinnerNoLocation(event.id.clone()));
        }

        // TRAVEL_NO_TRANSPORT
        if (title_lower.contains("flight") || title_lower.contains("train")
            || title_lower.contains("voyage") || title_lower.contains("déplacement"))
            && !todos.iter().any(|t| t.title.to_lowercase().contains("billet")
                || t.title.to_lowercase().contains("réserv"))
        {
            matches.push(HeuristicMatch::TravelNoTransport(event.id.clone()));
        }
    }

    matches
}
```

### Prompt

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 512,
  "messages": [
    {
      "role": "user",
      "content": "Voici des événements de mon calendrier qui nécessitent peut-être une action proactive. Pour chaque événement, génère une suggestion d'action concrète. Retourne UNIQUEMENT un JSON valide :\n{\"suggestions\": [{\"type\": \"restaurant_booking\"|\"follow_up\"|\"transport_check\", \"calendar_event_id\": \"...\", \"description\": \"...\"}]}\n\n## Événements concernés\n{MATCHED_EVENTS_JSON}"
    }
  ]
}
```

### Déduplication des suggestions

Ne pas créer une suggestion si une suggestion du même type pour le même `calendar_event_id` existe déjà (peu importe son status) :

```sql
SELECT id FROM suggestions
WHERE type = ? AND calendar_event_id = ?
LIMIT 1;
```

---

## Commandes Tauri

```rust
#[tauri::command]
async fn extract_todos_from_transcription(
    transcription_id: String,
    state: State<AppState>,
) -> Result<Vec<Todo>, String>

#[tauri::command]
async fn generate_weekly_synthesis(state: State<AppState>) -> Result<String, String>

#[tauri::command]
async fn get_weekly_synthesis(state: State<AppState>) -> Result<Option<WeeklySynthesis>, String>
// WeeklySynthesis: { text: string, generated_at: string }

#[tauri::command]
async fn generate_suggestions(state: State<AppState>) -> Result<Vec<Suggestion>, String>
```

### Événement sur erreur d'auth

```
"claude-auth-error" → {} 
```
L'UI affiche une modale "Clé API Claude invalide — veuillez la mettre à jour dans les paramètres".
