use anyhow::{anyhow, Result};
use serde::Deserialize;
use serde_json::json;
use sqlx::SqlitePool;
use std::path::Path;
use tauri::Emitter;

use crate::keychain;
use crate::notes::todo_md::IngestTask;

pub mod chat;
pub mod chat_history;

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

// ─── Ingestion fusionnée (spec/05) ──────────────────────────────────────────────
//
// One Claude call turns a transcription into a compte-rendu + extracted tasks.
// Replaces the old two-step "extract_todos_from_transcription" + CLI "ingest".
// Rust (never the AI) does all the writing: alfred-intelligence/{titre}.md
// (compte-rendu) and a dual-write of tasks — Todo.md (spec/06 target) + the
// SQLite `todos` table (kept in sync until the Tâches screen migrates to the
// file, a separate ROADMAP task).

const INGESTION_SYSTEM: &str = r#"Tu es Alfred, un assistant personnel. On te donne la transcription brute d'un enregistrement (réunion, note vocale, appel). Analyse-la et soumets un compte-rendu structuré via l'outil `submit_ingestion`.

Consignes :
- `resume` : compte-rendu structuré en Markdown (points clés abordés), en français, concis.
- `points_cles` : liste des points clés abordés, en phrases courtes.
- `taches` : chaque tâche à faire identifiée dans la transcription. Quand un responsable est nommé (prénom), rappelle-le dans `responsable` — c'est important, ne l'invente pas s'il n'est pas mentionné. `echeance` au format YYYY-MM-DD si une date est mentionnée, sinon omets-la.
- N'invente rien : si la transcription est trop courte ou vide de contenu exploitable, renvoie un résumé bref, une liste de points clés vide, et aucune tâche."#;

fn ingestion_tool() -> serde_json::Value {
    json!([{
        "name": "submit_ingestion",
        "description": "Soumets le compte-rendu structuré de la transcription et les tâches identifiées.",
        "input_schema": {
            "type": "object",
            "properties": {
                "resume": {
                    "type": "string",
                    "description": "Compte-rendu structuré en Markdown"
                },
                "points_cles": {
                    "type": "array",
                    "items": { "type": "string" }
                },
                "taches": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "titre": { "type": "string" },
                            "responsable": { "type": "string", "description": "Prénom du responsable, si identifiable" },
                            "echeance": { "type": "string", "description": "YYYY-MM-DD, si mentionnée" }
                        },
                        "required": ["titre"]
                    }
                }
            },
            "required": ["resume", "points_cles", "taches"]
        }
    }])
}

#[derive(Debug, Deserialize)]
struct IngestionOutput {
    resume: String,
    #[serde(default)]
    points_cles: Vec<String>,
    #[serde(default)]
    taches: Vec<IngestedTask>,
}

#[derive(Debug, Deserialize)]
struct IngestedTask {
    titre: String,
    #[serde(default)]
    responsable: Option<String>,
    #[serde(default)]
    echeance: Option<String>,
}

/// Vault-relative folder for AI-generated compte-rendus (spec/05).
const DEFAULT_INTELLIGENCE_FOLDER: &str = "alfred-intelligence";

pub async fn intelligence_folder(db: &SqlitePool) -> String {
    let stored: Option<String> = sqlx::query_scalar("SELECT value FROM config WHERE key = 'intelligence_folder'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    stored
        .map(|s| s.trim().trim_matches('/').trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_INTELLIGENCE_FOLDER.to_string())
}

/// One Claude call → `IngestionOutput`, forcing the `submit_ingestion` tool so the
/// response is always structured (no fragile "strip the ```json fence" parsing).
async fn call_ingestion(text: &str, db: &SqlitePool) -> Result<(IngestionOutput, &'static str)> {
    let access = resolve_access(db).await?;
    let client = reqwest::Client::new();

    let body = json!({
        "model": MODEL,
        "max_tokens": 4096,
        "thinking": {"type": "disabled"},
        "system": [{
            "type": "text",
            "text": INGESTION_SYSTEM,
            "cache_control": {"type": "ephemeral"}
        }],
        "tools": ingestion_tool(),
        "tool_choice": {"type": "tool", "name": "submit_ingestion"},
        "messages": [{
            "role": "user",
            "content": format!("Transcription:\n{}", text)
        }]
    });

    let resp = call_claude_with_retry(&client, &access, &body).await?;

    let content = resp["content"].as_array().cloned().unwrap_or_default();
    let block = content
        .iter()
        .find(|b| b["type"] == "tool_use" && b["name"] == "submit_ingestion")
        .ok_or_else(|| anyhow!("Claude did not call submit_ingestion: {:?}", resp))?;

    let output: IngestionOutput = serde_json::from_value(block["input"].clone())
        .map_err(|e| anyhow!("Invalid submit_ingestion input: {} — {:?}", e, block["input"]))?;

    Ok((output, access.mode))
}

/// Shared engine: run the ingestion call, then write everything (Rust does the
/// writing, never the AI). `recording_id` is `None` when re-ingesting a note that
/// isn't linked to a recording (spec/05 "note_path" entry point).
async fn run_ingestion_core(
    text: &str,
    note_title: &str,
    recording_id: Option<&str>,
    db: &SqlitePool,
    vault_root: Option<&Path>,
    app_handle: &tauri::AppHandle,
) -> Result<()> {
    // `ingestion-status-changed` (spec/13's guided tour + error surfacing) needs
    // an unambiguous done/error signal — `notes-updated`/`todos-updated` are too
    // generic (they can fire for unrelated reasons) to reliably drive UI waiting
    // on ingestion. Errors carry their message: a silent ingestion failure looks
    // exactly like "the feature doesn't work" (learned the hard way in testing).
    let emit_status = |status: &str, message: Option<String>| {
        let _ = app_handle.emit(
            "ingestion-status-changed",
            json!({ "status": status, "recording_id": recording_id, "message": message }),
        );
    };

    if text.trim().is_empty() {
        emit_status("done", None);
        return Ok(());
    }

    let (output, ai_mode) = match call_ingestion(text, db).await {
        Ok(r) => r,
        Err(e) => {
            emit_status("error", Some(e.to_string()));
            return Err(e);
        }
    };

    if let Some(vault_root) = vault_root {
        // 1. Compte-rendu → alfred-intelligence/{titre}.md
        let folder = vault_root.join(intelligence_folder(db).await);
        let metadata = crate::notes::NoteMetadata::for_meeting_report(note_title, recording_id, vec![], None);
        let mut body = output.resume.clone();
        if !output.points_cles.is_empty() {
            body.push_str("\n\n## Points clés\n");
            for p in &output.points_cles {
                body.push_str(&format!("- {}\n", p));
            }
        }
        match crate::notes::vault::create_intelligence_note(&folder, note_title, metadata, &body).await {
            Ok(_) => eprintln!("[ingestion] compte-rendu created: {}", note_title),
            Err(e) => eprintln!("[ingestion] failed to write compte-rendu: {}", e),
        }

        // 2. Tâches → Todo.md (spec/06 — the todos source of truth), deduped.
        if !output.taches.is_empty() {
            let todo_rel_path = crate::todos::todo_file_path(db).await;
            let tasks: Vec<IngestTask> = output
                .taches
                .iter()
                .map(|t| IngestTask {
                    titre: t.titre.clone(),
                    responsable: t.responsable.clone(),
                    echeance: t.echeance.clone(),
                })
                .collect();
            match crate::notes::todo_md::append_tasks(vault_root, &todo_rel_path, &tasks).await {
                Ok(n) => {
                    eprintln!("[ingestion] {} task(s) added to {}", n, todo_rel_path);
                    if n > 0 {
                        let _ = app_handle.emit("todos-updated", json!({ "count": n }));
                    }
                }
                Err(e) => eprintln!("[ingestion] failed to update Todo.md: {}", e),
            }
        }

        let _ = app_handle.emit("notes-updated", json!({}));
    } else {
        eprintln!("[ingestion] vault not configured, skipping note/Todo.md writes");
    }

    crate::metrics::send("ingestion_completed", json!({ "ai_mode": ai_mode }));
    emit_status("done", None);

    Ok(())
}

/// Automatic trigger, right after `transcription-complete` (spec/05).
pub async fn run_ingestion_for_recording(
    recording_id: &str,
    transcription_text: &str,
    note_title: &str,
    db: &SqlitePool,
    vault_root: Option<&Path>,
    app_handle: &tauri::AppHandle,
) -> Result<()> {
    run_ingestion_core(transcription_text, note_title, Some(recording_id), db, vault_root, app_handle).await
}

/// Manual "ré-ingérer" trigger, relaunched on a specific `alfred-raw/` note
/// (spec/05). Reads the note's body (frontmatter stripped) and, if the note
/// already carries a `recording_id`, keeps that link.
pub async fn run_ingestion_for_note(
    note_path: &Path,
    db: &SqlitePool,
    vault_root: Option<&Path>,
    app_handle: &tauri::AppHandle,
) -> Result<()> {
    let raw = tokio::fs::read_to_string(note_path)
        .await
        .map_err(|e| anyhow!("Cannot read {:?}: {}", note_path, e))?;

    let stem = note_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let (metadata, body) = crate::notes::frontmatter::parse(&raw, &stem);

    run_ingestion_core(&body, &metadata.title, metadata.recording_id.as_deref(), db, vault_root, app_handle).await
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

// ─── Brief quotidien (spec/05 usage 3) ──────────────────────────────────────────

const DAILY_BRIEF_SYSTEM: &str = r#"Tu es Alfred, un assistant personnel. À partir des tâches en cours et des notes récentes de l'utilisateur, rédige un résumé Markdown TRÈS COURT (3 à 5 lignes maximum) de ce qu'il faut savoir aujourd'hui : échéances proches, sujets chauds. N'invente rien. Si tu n'as rien de notable à signaler, dis-le en une phrase, chaleureuse et brève."#;

/// Generates the "Aujourd'hui" brief (spec/10) from current todos + recent notes,
/// and caches it (`daily_brief` + `daily_brief_last_run`) for `get_daily_brief`.
pub async fn generate_daily_brief(db: &SqlitePool, vault_root: Option<&Path>) -> Result<String> {
    let access = resolve_access(db).await?;

    let todos = crate::todos::get_todos(db, vault_root).await.unwrap_or_default();
    let todos_text = if todos.is_empty() {
        "Aucune tâche en attente.".to_string()
    } else {
        todos
            .iter()
            .take(15)
            .map(|t| {
                format!(
                    "- {}{}",
                    t.title,
                    t.echeance.as_deref().map(|d| format!(" (échéance {})", d)).unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let recents_text = match vault_root {
        Some(root) => {
            let root = root.to_path_buf();
            let recents = tokio::task::spawn_blocking(move || crate::notes::vault::list_recent_notes(&root, 5))
                .await?
                .unwrap_or_default();
            if recents.is_empty() {
                "Aucune note récente.".to_string()
            } else {
                recents.iter().map(|r| format!("- {}", r.title)).collect::<Vec<_>>().join("\n")
            }
        }
        None => "Vault non configuré.".to_string(),
    };

    let prompt = format!("## Tâches en cours\n{}\n\n## Notes récentes\n{}", todos_text, recents_text);

    let client = reqwest::Client::new();
    let body = json!({
        "model": MODEL,
        "max_tokens": 400,
        "thinking": {"type": "disabled"},
        "system": [{
            "type": "text",
            "text": DAILY_BRIEF_SYSTEM,
            "cache_control": {"type": "ephemeral"}
        }],
        "messages": [{"role": "user", "content": prompt}]
    });

    let resp = call_claude_with_retry(&client, &access, &body).await?;
    let text = resp["content"][0]["text"]
        .as_str()
        .ok_or_else(|| anyhow!("No text in Claude response"))?
        .to_string();

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    sqlx::query!("INSERT OR REPLACE INTO config (key, value) VALUES ('daily_brief', ?)", text)
        .execute(db)
        .await?;
    sqlx::query!("INSERT OR REPLACE INTO config (key, value) VALUES ('daily_brief_last_run', ?)", today)
        .execute(db)
        .await?;

    Ok(text)
}

/// Cached brief, if one was generated — `(text, generated_at date)`.
pub async fn get_daily_brief(db: &SqlitePool) -> Result<Option<(String, String)>> {
    let text: Option<String> = sqlx::query_scalar("SELECT value FROM config WHERE key = 'daily_brief'")
        .fetch_optional(db)
        .await?;
    let generated_at: Option<String> = sqlx::query_scalar("SELECT value FROM config WHERE key = 'daily_brief_last_run'")
        .fetch_optional(db)
        .await?;

    Ok(match (text, generated_at) {
        (Some(t), Some(d)) if !t.trim().is_empty() => Some((t, d)),
        _ => None,
    })
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
