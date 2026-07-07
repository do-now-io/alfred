use anyhow::{anyhow, Result};
use serde_json::json;
use sqlx::SqlitePool;
use tauri::Emitter;

use crate::keychain;

pub mod chat;

const MODEL: &str = "claude-sonnet-5";
const ANTHROPIC_BASE: &str = "https://api.anthropic.com";
const ALFREDIA_BASE: &str = "https://api.alfred.do-now.io";

/// Resolved AI access: which endpoint + auth header to use for Claude calls.
pub struct AiAccess {
    base_url: &'static str,
    auth_name: &'static str,
    auth_value: String,
    /// "byo" (personal key) or "alfredia" (proxy) — for metrics.
    mode: &'static str,
}

/// Pick the AI access mode from config (`ai_mode` = "alfredia" | "byo"), falling
/// back to whichever secret is present. Personal key → api.anthropic.com
/// (`x-api-key`); AlfredIA token → our proxy (`Authorization: Bearer`). The
/// request body is identical either way (Anthropic Messages API).
pub async fn resolve_access(db: &SqlitePool) -> Result<AiAccess> {
    let mode: Option<String> = sqlx::query_scalar("SELECT value FROM config WHERE key = 'ai_mode'")
        .fetch_optional(db)
        .await
        .unwrap_or(None);

    let alfredia = || {
        keychain::get_secret("alfredia_token")
            .ok()
            .flatten()
            .filter(|t| !t.is_empty())
    };
    let personal = || {
        keychain::get_secret("claude_api_key")
            .ok()
            .flatten()
            .filter(|k| !k.is_empty())
    };

    let bearer = |token: String| AiAccess {
        base_url: ALFREDIA_BASE,
        auth_name: "authorization",
        auth_value: format!("Bearer {token}"),
        mode: "alfredia",
    };
    let x_api_key = |key: String| AiAccess {
        base_url: ANTHROPIC_BASE,
        auth_name: "x-api-key",
        auth_value: key,
        mode: "byo",
    };

    match mode.as_deref() {
        Some("alfredia") => alfredia()
            .map(bearer)
            .ok_or_else(|| anyhow!("Abonnement AlfredIA non configuré. Réglages → IA.")),
        Some("byo") => personal()
            .map(x_api_key)
            .ok_or_else(|| anyhow!("Clé API Claude non configurée. Réglages → IA.")),
        // No explicit choice: prefer an AlfredIA token, else the personal key.
        _ => alfredia()
            .map(bearer)
            .or_else(|| personal().map(x_api_key))
            .ok_or_else(|| anyhow!("Aucun accès IA configuré (clé perso ou abonnement AlfredIA). Réglages → IA.")),
    }
}

const TODO_EXTRACTION_SYSTEM: &str = r#"Tu es un assistant qui extrait des tâches à faire depuis des transcriptions.
Tu dois retourner UNIQUEMENT un tableau JSON valide, rien d'autre.
Chaque tâche a les champs: title (string, obligatoire), description (string ou null), due_date (string YYYY-MM-DD ou null).
Si aucune tâche n'est détectée, retourne [].
Exemples de tâches: appels à passer, réunions à planifier, documents à envoyer, rendez-vous à prendre."#;

pub async fn extract_todos_from_transcription(
    transcription_id: &str,
    db: &SqlitePool,
    app_handle: &tauri::AppHandle,
) -> Result<Vec<crate::todos::Todo>> {
    let access = resolve_access(db).await?;

    let row = sqlx::query!(
        "SELECT raw_text, recording_id FROM transcriptions WHERE id = ?",
        transcription_id
    )
    .fetch_optional(db)
    .await?
    .ok_or_else(|| anyhow!("Transcription not found"))?;

    if row.raw_text.trim().is_empty() {
        return Ok(vec![]);
    }

    let client = reqwest::Client::new();

    let body = json!({
        "model": MODEL,
        "max_tokens": 1024,
        "system": [{
            "type": "text",
            "text": TODO_EXTRACTION_SYSTEM,
            "cache_control": {"type": "ephemeral"}
        }],
        "messages": [{
            "role": "user",
            "content": format!("Transcription:\n{}", row.raw_text)
        }]
    });

    let resp = call_claude_with_retry(&client, &access, &body).await?;

    let content = resp["content"][0]["text"]
        .as_str()
        .ok_or_else(|| anyhow!("No text in Claude response"))?;

    // Strip markdown code blocks if present
    let json_str = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let extracted: Vec<serde_json::Value> = serde_json::from_str(json_str)
        .map_err(|e| anyhow!("Failed to parse Claude response as JSON: {} — Response: {}", e, json_str))?;

    let mut todos = Vec::new();
    for item in extracted {
        let title = item["title"].as_str().unwrap_or("").trim().to_string();
        if title.is_empty() {
            continue;
        }
        let description = item["description"].as_str().map(|s| s.to_string());
        let due_date = item["due_date"].as_str().map(|s| s.to_string());

        match crate::todos::create_todo_internal(
            &title,
            description.as_deref(),
            "transcription",
            Some(transcription_id),
            due_date.as_deref(),
            db,
        )
        .await
        {
            Ok(todo) => todos.push(todo),
            Err(e) => eprintln!("Failed to create todo from transcription: {}", e),
        }
    }

    if !todos.is_empty() {
        let _ = app_handle.emit("todos-updated", json!({ "count": todos.len() }));
    }

    Ok(todos)
}

pub async fn generate_weekly_synthesis(db: &SqlitePool) -> Result<String> {
    let access = resolve_access(db).await?;

    // Gather week events
    let events = crate::calendar::get_week_events(db).await?;
    let events_text = events
        .iter()
        .map(|e| {
            format!(
                "- {} ({}{})",
                e.title,
                e.start_at,
                e.location.as_deref().map(|l| format!(" — {}", l)).unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    // Gather pending todos
    let todos = crate::todos::get_todos(db).await?;
    let todos_text = todos
        .iter()
        .map(|t| {
            format!(
                "- {}{}",
                t.title,
                t.due_date.as_deref().map(|d| format!(" (échéance: {})", d)).unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = format!(
        "Génère une synthèse hebdomadaire concise en Markdown (max 300 mots) pour un manager:\n\n\
         ## Événements de la semaine:\n{}\n\n## Tâches en cours:\n{}\n\n\
         Résume les priorités, identifie les conflits ou opportunités, et donne 2-3 recommandations.",
        if events_text.is_empty() { "Aucun événement" } else { &events_text },
        if todos_text.is_empty() { "Aucune tâche" } else { &todos_text }
    );

    let client = reqwest::Client::new();
    let body = json!({
        "model": MODEL,
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": prompt}]
    });

    let resp = call_claude_with_retry(&client, &access, &body).await?;

    let synthesis = resp["content"][0]["text"]
        .as_str()
        .ok_or_else(|| anyhow!("No text in Claude response"))?
        .to_string();

    // Store in config
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query!(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('weekly_synthesis', ?)",
        synthesis
    )
    .execute(db)
    .await?;
    sqlx::query!(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('weekly_synthesis_last_run', ?)",
        now
    )
    .execute(db)
    .await?;

    Ok(synthesis)
}

const EVENT_BRIEFING_SYSTEM: &str = r##"Tu es Alfred, un assistant personnel. On te donne un événement de calendrier, des extraits de notes personnelles potentiellement liées, et la liste des tâches en cours.
Génère un briefing concis en Markdown (max 250 mots) pour préparer cet événement, structuré avec ces sections (titres en ###):

### Dans vos notes
Ce que les notes disent à propos de cet événement (contexte, décisions passées, sujets ouverts). Mets en **gras** les noms, dates et points clés. Référence chaque note source par son titre EXACT entre double crochets, par ex. [[Titre de la note]] — recopie le titre à l'identique depuis l'en-tête « Note: » car il sert de lien cliquable.

### Tâches liées
Les tâches en cours qui concernent cet événement, en liste à puces.

### À préparer
2-3 points d'attention ou questions, en liste à puces.

Ne mentionne QUE ce qui est réellement lié à l'événement — ignore le reste. Omets une section si elle est vide. Si rien n'est lié du tout, réponds en une seule phrase, sans inventer."##;

pub async fn generate_event_briefing(
    event_id: &str,
    db: &SqlitePool,
    vault_root: Option<std::path::PathBuf>,
) -> Result<String> {
    let access = resolve_access(db).await?;

    let event = sqlx::query!(
        r#"SELECT title as "title!", start_at as "start_at!", end_at as "end_at!",
           location, description, attendees
           FROM calendar_events WHERE id = ?"#,
        event_id
    )
    .fetch_optional(db)
    .await?
    .ok_or_else(|| anyhow!("Événement introuvable"))?;

    let keywords = extract_keywords(&event.title, event.attendees.as_deref());

    let notes = match vault_root {
        Some(root) => {
            let kw = keywords.clone();
            tokio::task::spawn_blocking(move || find_relevant_notes(&root, &kw)).await?
        }
        None => vec![],
    };

    let notes_text = if notes.is_empty() {
        "Aucune note ne correspond aux mots-clés de l'événement.".to_string()
    } else {
        notes
            .iter()
            .map(|(title, body)| format!("### Note: {}\n{}", title, body))
            .collect::<Vec<_>>()
            .join("\n\n")
    };

    let todos = crate::todos::get_todos(db).await?;
    let todos_text = if todos.is_empty() {
        "Aucune tâche en cours.".to_string()
    } else {
        todos
            .iter()
            .map(|t| {
                format!(
                    "- {}{}{}",
                    t.title,
                    t.description.as_deref().map(|d| format!(" — {}", d)).unwrap_or_default(),
                    t.due_date.as_deref().map(|d| format!(" (échéance: {})", d)).unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let prompt = format!(
        "## Événement\nTitre: {}\nDébut: {}\nFin: {}\nLieu: {}\nParticipants: {}\nDescription: {}\n\n\
         ## Extraits de notes potentiellement liées\n{}\n\n## Tâches en cours\n{}",
        event.title,
        event.start_at,
        event.end_at,
        event.location.as_deref().unwrap_or("—"),
        event.attendees.as_deref().unwrap_or("—"),
        event.description.as_deref().unwrap_or("—"),
        notes_text,
        todos_text
    );

    let client = reqwest::Client::new();
    let body = json!({
        "model": MODEL,
        "max_tokens": 1024,
        "system": [{
            "type": "text",
            "text": EVENT_BRIEFING_SYSTEM,
            "cache_control": {"type": "ephemeral"}
        }],
        "messages": [{"role": "user", "content": prompt}]
    });

    let resp = call_claude_with_retry(&client, &access, &body).await?;

    resp["content"][0]["text"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow!("No text in Claude response"))
}

const STOPWORDS: &[&str] = &[
    "les", "des", "une", "avec", "pour", "dans", "sur", "aux", "est", "par",
    "point", "réunion", "reunion", "meeting", "call", "rdv", "the", "and",
    "weekly", "sync", "gmail", "com", "outlook", "google", "calendar", "mailto", "email",
];

fn extract_keywords(title: &str, attendees: Option<&str>) -> Vec<String> {
    let mut source = title.to_lowercase();
    if let Some(a) = attendees {
        source.push(' ');
        source.push_str(&a.to_lowercase());
    }

    let mut keywords: Vec<String> = source
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 3 && !STOPWORDS.contains(w))
        .map(|w| w.to_string())
        .collect();
    keywords.sort();
    keywords.dedup();
    keywords
}

/// Scans the vault for notes matching the event keywords.
/// Returns up to 6 (title, truncated body) pairs, best matches first.
fn find_relevant_notes(root: &std::path::Path, keywords: &[String]) -> Vec<(String, String)> {
    if keywords.is_empty() {
        return vec![];
    }

    let mut scored: Vec<(usize, String, String)> = vec![];

    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path().extension().map(|x| x == "md").unwrap_or(false)
                && !e.path().components().any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        })
        .take(5000)
    {
        let Ok(content) = std::fs::read_to_string(entry.path()) else { continue };
        let title = entry
            .path()
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        let title_lower = title.to_lowercase();
        let content_lower = content.to_lowercase();

        let score: usize = keywords
            .iter()
            .map(|kw| {
                let in_title = if title_lower.contains(kw.as_str()) { 5 } else { 0 };
                let in_body = content_lower.matches(kw.as_str()).count().min(10);
                in_title + in_body
            })
            .sum();

        if score > 0 {
            let truncated: String = content.chars().take(1500).collect();
            scored.push((score, title, truncated));
        }
    }

    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored.truncate(6);
    scored.into_iter().map(|(_, t, b)| (t, b)).collect()
}

async fn call_claude_with_retry(
    client: &reqwest::Client,
    access: &AiAccess,
    body: &serde_json::Value,
) -> Result<serde_json::Value> {
    let url = format!("{}/v1/messages", access.base_url);
    let mut last_err = anyhow!("No attempts made");

    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(tokio::time::Duration::from_secs(1 << attempt)).await;
        }

        let result = client
            .post(&url)
            .header(access.auth_name, access.auth_value.as_str())
            .header("anthropic-version", "2023-06-01")
            .json(body)
            .send()
            .await;

        match result {
            Ok(resp) => {
                let status = resp.status();
                let json = resp.json::<serde_json::Value>().await?;
                if status.is_success() {
                    // AlfredIA requests are counted server-side by the proxy;
                    // only personal-key usage is reported from the app.
                    if access.mode == "byo" {
                        crate::metrics::send(
                            "ai_request",
                            serde_json::json!({ "kind": "messages", "ai_mode": "byo" }),
                        );
                    }
                    return Ok(json);
                }
                // Don't retry 4xx (except 429)
                if status.is_client_error() && status.as_u16() != 429 {
                    return Err(anyhow!(
                        "Claude API error {}: {}",
                        status,
                        json["error"]["message"].as_str().unwrap_or("unknown")
                    ));
                }
                last_err = anyhow!("Claude API {}: {:?}", status, json);
            }
            Err(e) => {
                last_err = e.into();
            }
        }
    }

    Err(last_err)
}

pub async fn test_api_key(service: &str, client: &reqwest::Client) -> Result<()> {
    match service {
        "claude" => {
            let key = keychain::get_secret("claude_api_key")?
                .filter(|k| !k.is_empty())
                .ok_or_else(|| anyhow!("No Claude API key configured"))?;

            let resp = client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", &key)
                .header("anthropic-version", "2023-06-01")
                .json(&json!({
                    "model": "claude-haiku-4-5-20251001",
                    "max_tokens": 1,
                    "messages": [{"role": "user", "content": "Hi"}]
                }))
                .send()
                .await?;

            if resp.status() == 401 {
                Err(anyhow!("Clé API Claude invalide"))
            } else {
                Ok(())
            }
        }
        "vapi" => {
            let key = keychain::get_secret("vapi_api_key")?
                .filter(|k| !k.is_empty())
                .ok_or_else(|| anyhow!("No Vapi API key configured"))?;

            let resp = client
                .get("https://api.vapi.ai/phone-number")
                .bearer_auth(&key)
                .send()
                .await?;

            if resp.status() == 401 {
                Err(anyhow!("Clé API Vapi invalide"))
            } else {
                Ok(())
            }
        }
        "alfredia" => {
            let token = keychain::get_secret("alfredia_token")?
                .filter(|t| !t.is_empty())
                .ok_or_else(|| anyhow!("Aucun abonnement AlfredIA configuré"))?;

            let resp = client
                .post(format!("{}/v1/messages", ALFREDIA_BASE))
                .header("authorization", format!("Bearer {token}"))
                .header("anthropic-version", "2023-06-01")
                .json(&json!({
                    "model": "claude-haiku-4-5",
                    "max_tokens": 1,
                    "messages": [{"role": "user", "content": "Hi"}]
                }))
                .send()
                .await?;

            match resp.status().as_u16() {
                401 => Err(anyhow!("Token AlfredIA invalide")),
                402 => Err(anyhow!("Abonnement AlfredIA inactif")),
                _ => Ok(()),
            }
        }
        _ => Err(anyhow!("Unknown service: {}", service)),
    }
}
