use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::SqlitePool;
use std::path::Path;
use tauri::Emitter;
use ts_rs::TS;

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
- `participants` : les prénoms des personnes présentes / citées comme participant à l'échange (pas les personnes simplement mentionnées). Liste vide si indéterminable.
- `project` : le nom du projet concerné, UNIQUEMENT s'il est clairement identifiable (nommé dans la transcription ou reconnaissable via le contexte interne). Omets-le sinon — ne devine pas.
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
                },
                "participants": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Prénoms des participants à l'échange"
                },
                "project": {
                    "type": "string",
                    "description": "Nom du projet concerné, seulement si clairement identifiable"
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
    #[serde(default)]
    participants: Vec<String>,
    #[serde(default)]
    project: Option<String>,
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

/// System blocks with the optional contexte interne (spec/16) appended, the
/// `cache_control` marker sitting on the LAST block so the whole stable prefix
/// is cached — not just the first block.
fn system_blocks(base_prompt: &str, context: Option<&str>) -> serde_json::Value {
    let mut blocks = vec![json!({ "type": "text", "text": base_prompt })];
    if let Some(ctx) = context.map(str::trim).filter(|c| !c.is_empty()) {
        blocks.push(json!({
            "type": "text",
            "text": format!("Contexte interne de l'utilisateur (entreprise, équipe, vocabulaire — sers-t'en pour orthographier correctement les prénoms et termes maison) :\n\n{}", ctx)
        }));
    }
    blocks.last_mut().unwrap()["cache_control"] = json!({ "type": "ephemeral" });
    json!(blocks)
}

/// One Claude call → `IngestionOutput`, forcing the `submit_ingestion` tool so the
/// response is always structured (no fragile "strip the ```json fence" parsing).
async fn call_ingestion(
    text: &str,
    context: Option<&str>,
    db: &SqlitePool,
) -> Result<(IngestionOutput, &'static str)> {
    let access = resolve_access(db).await?;
    let client = reqwest::Client::new();

    let body = json!({
        "model": MODEL,
        "max_tokens": 4096,
        "thinking": {"type": "disabled"},
        "system": system_blocks(INGESTION_SYSTEM, context),
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

    // Contexte interne (spec/16) : helps the ingestion spell names/teams right.
    let context = match vault_root {
        Some(root) => crate::notes::context::read_context(root, db).await,
        None => None,
    };

    let (output, ai_mode) = match call_ingestion(text, context.as_deref(), db).await {
        Ok(r) => r,
        Err(e) => {
            emit_status("error", Some(e.to_string()));
            return Err(e);
        }
    };

    if let Some(vault_root) = vault_root {
        // 1. Compte-rendu → alfred-intelligence/{titre}.md
        let folder = vault_root.join(intelligence_folder(db).await);
        let project = output.project.as_deref().map(str::trim).filter(|p| !p.is_empty()).map(str::to_string);
        let metadata = crate::notes::NoteMetadata::for_meeting_report(note_title, recording_id, output.participants.clone(), project);
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

/// Automatic trigger, right after `transcription-complete` (spec/05). Routes
/// through the augmented two-step flow (spec/17 §3) when `augmented_ingestion` is
/// enabled, otherwise runs the direct one-shot ingestion (default — no regression
/// while the resolution UI is being built).
pub async fn run_ingestion_for_recording(
    recording_id: &str,
    transcription_text: &str,
    note_title: &str,
    db: &SqlitePool,
    vault_root: Option<&Path>,
    app_handle: &tauri::AppHandle,
) -> Result<()> {
    if !augmented_ingestion_enabled(db).await {
        return run_ingestion_core(transcription_text, note_title, Some(recording_id), db, vault_root, app_handle).await;
    }

    // Augmented: analyze first. Any analysis failure falls back to a direct
    // ingestion — we never drop the compte-rendu just because analysis broke.
    let context = match vault_root {
        Some(root) => crate::notes::context::read_context(root, db).await,
        None => None,
    };
    let clarifications = match call_analyze(transcription_text, context.as_deref(), db).await {
        Ok(mut c) => {
            let segments = fetch_segments(recording_id, db).await.unwrap_or_default();
            fill_timestamps(&mut c, &segments);
            c
        }
        Err(e) => {
            eprintln!("[analyze] failed, falling back to direct ingestion: {}", e);
            return run_ingestion_core(transcription_text, note_title, Some(recording_id), db, vault_root, app_handle).await;
        }
    };

    if !clarifications.has_actionable() {
        // Nothing worth validating → enchaîne automatiquement (spec/17 §3, aucune
        // friction). Learned facts (non-blocking) are still written.
        let adds = clarifications.context_addition_facts();
        return finalize_ingestion(recording_id, transcription_text, note_title, adds, db, vault_root, app_handle).await;
    }

    // Something to validate → hand off to the resolution screen (spec/17 §3). The
    // compte-rendu is written only at `finalize_ingestion`, on the corrected text.
    let _ = app_handle.emit(
        "clarifications-ready",
        json!({
            "recording_id": recording_id,
            "note_title": note_title,
            "text": transcription_text,
            "clarifications": clarifications,
        }),
    );
    Ok(())
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

// ─── Ingestion augmentée en deux temps (spec/17 §3) ──────────────────────────────
//
// Analyse (1 appel Claude) → propositions groupées seuillées → l'utilisateur
// tranche dans un écran de résolution → finalisation sur le texte corrigé. Jamais
// d'auto-application d'une correction ; si rien à signaler, on enchaîne tout seul.
// Derrière le flag config `augmented_ingestion` tant que l'écran n'est pas livré.

/// A doubtful passage Claude proposes to correct, with a re-listen anchor. Only
/// emitted when Claude has a referent in the context (spec/17 §3) — never a guess.
#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TranscriptionFix {
    /// Verbatim doubtful passage from the transcription (the citation).
    pub quote: String,
    /// Proposed corrected text.
    pub correction: String,
    /// 0..1 confidence (thresholding is Claude's; kept for display/sorting).
    #[serde(default)]
    pub confidence: Option<f64>,
    /// Re-listen window (seconds), located by matching `quote` to segments.
    #[serde(default)]
    pub start: Option<f64>,
    #[serde(default)]
    pub end: Option<f64>,
}

/// A task with no identified owner → ask "who?".
#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct UnassignedTask {
    pub task: String,
    pub question: String,
}

/// An important but unclear sentence → proposed understanding to confirm.
#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct UnclearSentence {
    pub quote: String,
    pub proposed: String,
    #[serde(default)]
    pub start: Option<f64>,
    #[serde(default)]
    pub end: Option<f64>,
}

/// A fact learned about the user's world (e.g. "Marie = cheffe de projet") →
/// auto-written to `## Appris automatiquement` (spec/17 §4), non-blocking.
#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ContextAddition {
    pub fact: String,
}

/// Grouped, thresholded propositions produced by the analysis pass (spec/17 §3).
#[derive(Debug, Serialize, Deserialize, Clone, Default, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Clarifications {
    #[serde(default)]
    pub transcription_fixes: Vec<TranscriptionFix>,
    #[serde(default)]
    pub unassigned_tasks: Vec<UnassignedTask>,
    #[serde(default)]
    pub unclear_sentences: Vec<UnclearSentence>,
    #[serde(default)]
    pub context_additions: Vec<ContextAddition>,
}

impl Clarifications {
    /// Whether anything needs the user to validate before finalizing.
    /// `context_additions` are auto-written (non-blocking) so they don't count.
    fn has_actionable(&self) -> bool {
        !self.transcription_fixes.is_empty()
            || !self.unassigned_tasks.is_empty()
            || !self.unclear_sentences.is_empty()
    }

    fn context_addition_facts(&self) -> Vec<String> {
        self.context_additions.iter().map(|c| c.fact.clone()).collect()
    }
}

const ANALYZE_SYSTEM: &str = r#"Tu es Alfred. On te donne la transcription brute d'un enregistrement (réunion, note vocale, appel) et, éventuellement, le contexte interne de l'utilisateur (entreprise, équipe, vocabulaire). AVANT de rédiger le compte-rendu, tu repères ce qui mérite une VALIDATION humaine. Soumets tes propositions via l'outil `submit_clarifications`.

Sois SÉLECTIF : ne remonte que ce qui est vraiment utile (haute confiance ou vraie importance). Si tout est clair, renvoie des listes vides — c'est un cas normal et souhaitable.

- `transcription_fixes` : un passage probablement MAL TRANSCRIT que tu sais corriger UNIQUEMENT parce que le contexte interne te donne le bon référent (ex. un prénom, un nom de projet, un terme métier). `quote` = le passage douteux recopié mot pour mot depuis la transcription ; `correction` = la version corrigée ; `confidence` entre 0 et 1. N'invente JAMAIS une correction sans référent dans le contexte.
- `unassigned_tasks` : une tâche à faire clairement énoncée mais SANS responsable identifiable. `task` = la tâche ; `question` = la question à poser (ex. « Qui s'en charge ? »).
- `unclear_sentences` : une phrase IMPORTANTE mais floue/ambiguë. `quote` = la phrase ; `proposed` = ta compréhension proposée.
- `context_additions` : un fait durable appris sur l'univers de l'utilisateur (ex. « Marie = cheffe de projet », « le projet Atlas concerne le client Dupont »). `fact` = le fait, en une ligne."#;

fn analyze_tool() -> serde_json::Value {
    json!([{
        "name": "submit_clarifications",
        "description": "Soumets les points à valider avant de finaliser le compte-rendu.",
        "input_schema": {
            "type": "object",
            "properties": {
                "transcription_fixes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "quote": { "type": "string" },
                            "correction": { "type": "string" },
                            "confidence": { "type": "number", "description": "0 à 1" }
                        },
                        "required": ["quote", "correction"]
                    }
                },
                "unassigned_tasks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "task": { "type": "string" },
                            "question": { "type": "string" }
                        },
                        "required": ["task", "question"]
                    }
                },
                "unclear_sentences": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "quote": { "type": "string" },
                            "proposed": { "type": "string" }
                        },
                        "required": ["quote", "proposed"]
                    }
                },
                "context_additions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": { "fact": { "type": "string" } },
                        "required": ["fact"]
                    }
                }
            },
            "required": ["transcription_fixes", "unassigned_tasks", "unclear_sentences", "context_additions"]
        }
    }])
}

/// One Claude call → `Clarifications` (timestamps not yet filled). Forces the
/// `submit_clarifications` tool so the response is always structured.
async fn call_analyze(text: &str, context: Option<&str>, db: &SqlitePool) -> Result<Clarifications> {
    if text.trim().is_empty() {
        return Ok(Clarifications::default());
    }
    let access = resolve_access(db).await?;
    let client = reqwest::Client::new();
    let body = json!({
        "model": MODEL,
        "max_tokens": 2048,
        "thinking": {"type": "disabled"},
        "system": system_blocks(ANALYZE_SYSTEM, context),
        "tools": analyze_tool(),
        "tool_choice": {"type": "tool", "name": "submit_clarifications"},
        "messages": [{ "role": "user", "content": format!("Transcription:\n{}", text) }]
    });

    let resp = call_claude_with_retry(&client, &access, &body).await?;
    let block = resp["content"]
        .as_array()
        .and_then(|c| c.iter().find(|b| b["type"] == "tool_use" && b["name"] == "submit_clarifications"))
        .ok_or_else(|| anyhow!("Claude did not call submit_clarifications: {:?}", resp))?;

    serde_json::from_value(block["input"].clone())
        .map_err(|e| anyhow!("Invalid submit_clarifications input: {} — {:?}", e, block["input"]))
}

/// Load a recording's transcription segments (for re-listen timestamps).
async fn fetch_segments(recording_id: &str, db: &SqlitePool) -> Result<Vec<crate::transcription::WhisperSegment>> {
    let json: Option<String> = sqlx::query_scalar(
        "SELECT segments_json FROM transcriptions WHERE recording_id = ?",
    )
    .bind(recording_id)
    .fetch_optional(db)
    .await?;
    match json {
        Some(s) => Ok(serde_json::from_str(&s).unwrap_or_default()),
        None => Ok(vec![]),
    }
}

fn normalize(s: &str) -> String {
    s.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Locate a quote in the segments → (start, end) seconds, for the "🔊 réécouter"
/// button (spec/17 §3). Fuzzy: matches on containment or a shared head chunk;
/// returns `None` bounds when nothing lines up (the fix is still shown, just
/// without a re-listen anchor).
fn locate_quote(quote: &str, segments: &[crate::transcription::WhisperSegment]) -> (Option<f64>, Option<f64>) {
    let q = normalize(quote);
    if q.is_empty() {
        return (None, None);
    }
    let head: String = q.split_whitespace().take(4).collect::<Vec<_>>().join(" ");
    let mut start = None;
    let mut end = None;
    for seg in segments {
        let t = normalize(&seg.text);
        if t.is_empty() {
            continue;
        }
        let hit = q.contains(&t) || t.contains(&q) || (!head.is_empty() && t.contains(&head));
        if hit {
            if start.is_none() {
                start = Some(seg.start);
            }
            end = Some(seg.end);
        }
    }
    (start, end)
}

fn fill_timestamps(clar: &mut Clarifications, segments: &[crate::transcription::WhisperSegment]) {
    for f in &mut clar.transcription_fixes {
        let (s, e) = locate_quote(&f.quote, segments);
        f.start = s;
        f.end = e;
    }
    for u in &mut clar.unclear_sentences {
        let (s, e) = locate_quote(&u.quote, segments);
        u.start = s;
        u.end = e;
    }
}

/// Is the augmented two-step ingestion enabled? (Config `augmented_ingestion`.)
/// Default **ON** (spec/17 §3) — only an explicit "false"/"0" turns it off.
async fn augmented_ingestion_enabled(db: &SqlitePool) -> bool {
    let v: Option<String> = sqlx::query_scalar("SELECT value FROM config WHERE key = 'augmented_ingestion'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    !matches!(v.as_deref(), Some("false") | Some("0"))
}

/// Debounce generation for glossary auto-regen (spec/17 §1/§4).
static GLOSSARY_REGEN_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const GLOSSARY_REGEN_DEBOUNCE_MS: u64 = 4000;

/// Regenerate the Whisper glossary after a context-note edit, **debounced**: each
/// call supersedes the previous pending one, so a burst of keystrokes triggers a
/// single regen ~4 s after the last change (spec/17 §4 — no manual button needed).
pub fn schedule_glossary_regen(db: SqlitePool, vault_root: std::path::PathBuf) {
    use std::sync::atomic::Ordering;
    let my_gen = GLOSSARY_REGEN_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(GLOSSARY_REGEN_DEBOUNCE_MS)).await;
        // A newer edit came in during the wait → let that one regenerate instead.
        if GLOSSARY_REGEN_GEN.load(Ordering::SeqCst) != my_gen {
            return;
        }
        match generate_glossary_from_context(&db, Some(&vault_root)).await {
            Ok(g) => eprintln!("[glossary] auto-regenerated after context edit ({} chars)", g.len()),
            Err(e) => eprintln!("[glossary] auto-regen failed: {}", e),
        }
    });
}

/// Analysis pass exposed to the UI (spec/17 §3): fetch the transcription of a
/// recording, ask Claude for grouped propositions, and locate re-listen windows.
pub async fn analyze_transcription(
    recording_id: &str,
    db: &SqlitePool,
    vault_root: Option<&Path>,
) -> Result<Clarifications> {
    let text: Option<String> =
        sqlx::query_scalar("SELECT raw_text FROM transcriptions WHERE recording_id = ?")
            .bind(recording_id)
            .fetch_optional(db)
            .await?;
    let text = text.ok_or_else(|| anyhow!("No transcription for recording {}", recording_id))?;

    let context = match vault_root {
        Some(root) => crate::notes::context::read_context(root, db).await,
        None => None,
    };
    let mut clar = call_analyze(&text, context.as_deref(), db).await?;
    let segments = fetch_segments(recording_id, db).await.unwrap_or_default();
    fill_timestamps(&mut clar, &segments);
    Ok(clar)
}

/// Finalization pass (spec/17 §3): write the compte-rendu from the CORRECTED text
/// (+ the user's answers already folded into it), then auto-write any accepted
/// learned facts to `## Appris automatiquement` and regenerate the glossary. Also
/// the auto path when the analysis had nothing to validate.
pub async fn finalize_ingestion(
    recording_id: &str,
    corrected_text: &str,
    note_title: &str,
    context_additions: Vec<String>,
    db: &SqlitePool,
    vault_root: Option<&Path>,
    app_handle: &tauri::AppHandle,
) -> Result<()> {
    run_ingestion_core(corrected_text, note_title, Some(recording_id), db, vault_root, app_handle).await?;

    if let Some(root) = vault_root {
        if !context_additions.is_empty() {
            match crate::notes::context::append_learned_facts(root, db, &context_additions).await {
                Ok(n) if n > 0 => {
                    eprintln!("[ingestion] {} fait(s) appris ajouté(s) au contexte", n);
                    // New context → the glossary may have new proper nouns (spec/17 §1/§4).
                    if let Err(e) = generate_glossary_from_context(db, Some(root)).await {
                        eprintln!("[ingestion] glossary regen failed: {}", e);
                    }
                    let _ = app_handle.emit("notes-updated", json!({}));
                }
                Ok(_) => {}
                Err(e) => eprintln!("[ingestion] append learned facts failed: {}", e),
            }
        }
    }
    Ok(())
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

// ─── Glossaire Whisper dérivé du contexte (spec/17 §1) ───────────────────────────
//
// Claude reads `Contexte Alfred.md` (spec/16) and derives a FLAT list of proper
// nouns / house terms — no definitions (Whisper is acoustic, not semantic) —
// wrapped in a short French sentence. Stored in `config.transcription_glossary`
// and injected as Whisper's `initial_prompt` (see transcription/mod.rs) to fix
// proper nouns at the source ("Ulysse" vs "Le vice").

/// ~224 tokens is Whisper's usable prompt budget (n_text_ctx/2). We can't count
/// Whisper tokens here, so this char cap is a coarse backstop (~64 names ×
/// ~15 chars); Claude is also told the budget. whisper.cpp keeps the *last*
/// prompt tokens on overflow, so we truncate the TAIL ourselves (Claude orders
/// the most-important/most-mis-transcribed names first — spec/17 §1).
const GLOSSARY_MAX_CHARS: usize = 1000;

const GLOSSARY_SYSTEM: &str = r#"Tu construis le GLOSSAIRE d'un moteur de transcription vocale (Whisper) à partir du contexte interne d'un utilisateur (son entreprise, son équipe, ses clients, ses projets, son vocabulaire). Ce glossaire aide Whisper à bien orthographier les noms propres et termes métier à l'oral.

Soumets le glossaire via l'outil `submit_glossary`. Règles STRICTES :
- Une liste PLATE de noms propres et termes uniquement : prénoms/noms de personnes, entreprises, clients, projets (noms de code), outils, sigles, jargon maison. AUCUNE définition, AUCUNE explication, AUCune phrase (Whisper est acoustique, pas sémantique). Ex. « Kubernetes, Grafana, ArgoCD, Terraform », pas « Kube = Kubernetes ».
- Ordonne les termes du plus important / le plus susceptible d'être mal transcrit au moins important (la fin peut être tronquée).
- Budget : environ 60 à 90 termes maximum (~200 tokens). Reste concis.
- Enrobe la liste dans une courte phrase, dans la langue principale du contexte (français par défaut), sur ce modèle : « Transcription en français. Termes et noms propres : <liste séparée par des virgules>. »
- Si le contexte ne contient aucun nom propre / terme exploitable, renvoie une chaîne vide."#;

fn glossary_tool() -> serde_json::Value {
    json!([{
        "name": "submit_glossary",
        "description": "Soumets le glossaire plat (noms propres et termes) pour l'initial_prompt de Whisper.",
        "input_schema": {
            "type": "object",
            "properties": {
                "glossaire": {
                    "type": "string",
                    "description": "Une seule ligne : courte phrase d'enrobage + liste plate de noms/termes séparés par des virgules. Vide si rien d'exploitable."
                }
            },
            "required": ["glossaire"]
        }
    }])
}

/// Truncate to the token budget, cutting on a comma boundary so we never leave a
/// half-spelled name in the prompt. Keeps the head (Claude ordered by importance).
fn cap_glossary(s: &str) -> String {
    let s = s.trim();
    if s.chars().count() <= GLOSSARY_MAX_CHARS {
        return s.to_string();
    }
    let head: String = s.chars().take(GLOSSARY_MAX_CHARS).collect();
    match head.rfind(',') {
        Some(i) => head[..i].trim_end().to_string(),
        None => head.trim_end().to_string(),
    }
}

/// Derive the Whisper glossary from `Contexte Alfred.md` and store it in
/// `config.transcription_glossary` (spec/17 §1). Regenerated at onboarding, when
/// the context note changes (debounced, caller's job), or via a manual button.
/// Empty context → empty glossary stored (Whisper falls back to no prompt).
pub async fn generate_glossary_from_context(db: &SqlitePool, vault_root: Option<&Path>) -> Result<String> {
    let context = match vault_root {
        Some(root) => crate::notes::context::read_context(root, db).await,
        None => None,
    };

    // No usable context → clear any stale glossary, nothing to derive.
    let context = match context {
        Some(c) => c,
        None => {
            store_glossary(db, "").await?;
            return Ok(String::new());
        }
    };

    let access = resolve_access(db).await?;
    let client = reqwest::Client::new();
    let body = json!({
        "model": MODEL,
        "max_tokens": 1024,
        "thinking": {"type": "disabled"},
        "system": [{
            "type": "text",
            "text": GLOSSARY_SYSTEM,
            "cache_control": {"type": "ephemeral"}
        }],
        "tools": glossary_tool(),
        "tool_choice": {"type": "tool", "name": "submit_glossary"},
        "messages": [{
            "role": "user",
            "content": format!("Contexte interne :\n\n{}", context)
        }]
    });

    let resp = call_claude_with_retry(&client, &access, &body).await?;
    let block = resp["content"]
        .as_array()
        .and_then(|c| c.iter().find(|b| b["type"] == "tool_use" && b["name"] == "submit_glossary"))
        .ok_or_else(|| anyhow!("Claude did not call submit_glossary: {:?}", resp))?;

    let glossaire = block["input"]["glossaire"].as_str().unwrap_or("").to_string();
    let capped = cap_glossary(&glossaire);
    store_glossary(db, &capped).await?;
    Ok(capped)
}

async fn store_glossary(db: &SqlitePool, value: &str) -> Result<()> {
    sqlx::query!(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('transcription_glossary', ?)",
        value
    )
    .execute(db)
    .await?;
    Ok(())
}

// ─── Contexte à la voix (onboarding, spec/13) ────────────────────────────────────
//
// The guided tour's first recording IS the creation of `Contexte Alfred.md`: the
// user introduces themselves aloud, Claude structures the transcription into the
// note's standard sections, then the glossary is derived. No compte-rendu.

const CONTEXT_BUILD_SYSTEM: &str = r#"Tu es Alfred. L'utilisateur vient de se présenter à voix haute pour t'apprendre son univers de travail (qui il est, son entreprise, son équipe, ses clients, ses projets, son vocabulaire métier). On te donne la transcription. Structure-la dans sa fiche de contexte via l'outil `submit_context`.

Consignes :
- `entreprise` : qui est l'utilisateur, son rôle, son entreprise et ce qu'elle fait, ce qu'il va enregistrer. Quelques phrases ou puces.
- `equipe` : les collègues cités (prénom + rôle), en liste à puces « - Prénom : rôle ». Vide si rien.
- `vocabulaire` : noms propres, clients, sigles, outils et jargon cités, en liste à puces. C'est la matière du glossaire de transcription : sois exhaustif sur les noms propres et termes techniques. Vide si rien.
- `projets` : les projets en cours cités (nom + une ligne), en liste à puces. Vide si rien.
- Reste fidèle : n'invente pas d'information non dite. Rédige en français. Orthographie au mieux les noms propres (au besoin d'après le son)."#;

fn context_build_tool() -> serde_json::Value {
    json!([{
        "name": "submit_context",
        "description": "Structure la présentation orale dans la fiche de contexte de l'utilisateur.",
        "input_schema": {
            "type": "object",
            "properties": {
                "entreprise": { "type": "string" },
                "equipe": { "type": "string" },
                "vocabulaire": { "type": "string" },
                "projets": { "type": "string" }
            },
            "required": ["entreprise", "equipe", "vocabulaire", "projets"]
        }
    }])
}

#[derive(Debug, Deserialize)]
struct ContextSections {
    #[serde(default)]
    entreprise: String,
    #[serde(default)]
    equipe: String,
    #[serde(default)]
    vocabulaire: String,
    #[serde(default)]
    projets: String,
}

/// Build `Contexte Alfred.md` from a spoken-introduction transcription and derive
/// the first glossary (spec/13). Emits `context-status-changed` for the guided
/// tour. Auto path from `process_job` when a recording's purpose is "context".
pub async fn build_context_from_transcription(
    recording_id: &str,
    transcription_text: &str,
    db: &SqlitePool,
    vault_root: Option<&Path>,
    app_handle: &tauri::AppHandle,
) -> Result<()> {
    let emit_status = |status: &str, sections: usize, terms: usize, message: Option<String>| {
        let _ = app_handle.emit(
            "context-status-changed",
            json!({
                "status": status,
                "recording_id": recording_id,
                "sections_filled": sections,
                "glossary_terms": terms,
                "message": message,
            }),
        );
    };

    let vault_root = match vault_root {
        Some(v) => v,
        None => {
            // No vault → nothing to write; treat as a graceful no-op done.
            emit_status("done", 0, 0, None);
            return Ok(());
        }
    };

    match build_context_inner(transcription_text, db, vault_root).await {
        Ok((sections, terms)) => {
            let _ = app_handle.emit("notes-updated", json!({}));
            emit_status("done", sections, terms, None);
            Ok(())
        }
        Err(e) => {
            emit_status("error", 0, 0, Some(e.to_string()));
            Err(e)
        }
    }
}

async fn build_context_inner(
    transcription_text: &str,
    db: &SqlitePool,
    vault_root: &Path,
) -> Result<(usize, usize)> {
    if transcription_text.trim().is_empty() {
        return Err(anyhow!("Transcription vide — rien à structurer"));
    }

    let access = resolve_access(db).await?;
    let client = reqwest::Client::new();
    let body = json!({
        "model": MODEL,
        "max_tokens": 2048,
        "thinking": {"type": "disabled"},
        "system": [{ "type": "text", "text": CONTEXT_BUILD_SYSTEM, "cache_control": {"type": "ephemeral"} }],
        "tools": context_build_tool(),
        "tool_choice": {"type": "tool", "name": "submit_context"},
        "messages": [{ "role": "user", "content": format!("Présentation orale :\n{}", transcription_text) }]
    });

    let resp = call_claude_with_retry(&client, &access, &body).await?;
    let block = resp["content"]
        .as_array()
        .and_then(|c| c.iter().find(|b| b["type"] == "tool_use" && b["name"] == "submit_context"))
        .ok_or_else(|| anyhow!("Claude did not call submit_context: {:?}", resp))?;
    let sections: ContextSections = serde_json::from_value(block["input"].clone())
        .map_err(|e| anyhow!("Invalid submit_context input: {} — {:?}", e, block["input"]))?;

    // Assemble the body using the same headings as the context-note template
    // (spec/16) so glossary derivation and manual editing stay consistent.
    let section = |title: &str, content: &str| {
        let c = content.trim();
        format!("## {}\n\n{}\n", title, c)
    };
    let body = format!(
        "# Contexte Alfred\n\n{}\n{}\n{}\n{}",
        section("Mon entreprise", &sections.entreprise),
        section("Équipe (prénoms & rôles)", &sections.equipe),
        section("Vocabulaire maison & noms propres", &sections.vocabulaire),
        section("Projets en cours", &sections.projets),
    );

    let filled = [&sections.entreprise, &sections.equipe, &sections.vocabulaire, &sections.projets]
        .iter()
        .filter(|s| !s.trim().is_empty())
        .count();

    crate::notes::context::write_spoken_context(vault_root, db, &body).await?;

    // First glossary from the freshly-written context (spec/17 §1).
    let glossary = generate_glossary_from_context(db, Some(vault_root)).await.unwrap_or_default();
    let terms = if glossary.trim().is_empty() { 0 } else { glossary.split(',').count() };

    Ok((filled, terms))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcription::WhisperSegment;

    fn seg(start: f64, end: f64, text: &str) -> WhisperSegment {
        WhisperSegment { start, end, text: text.to_string() }
    }

    #[test]
    fn cap_glossary_keeps_short_list() {
        let s = "Transcription en français. Termes et noms propres : Ulysse, Alfred.";
        assert_eq!(cap_glossary(s), s);
    }

    #[test]
    fn cap_glossary_truncates_on_comma_boundary() {
        let names: Vec<String> = (0..300).map(|i| format!("Nom{}", i)).collect();
        let long = format!("Prefixe : {}.", names.join(", "));
        let capped = cap_glossary(&long);
        assert!(capped.chars().count() <= GLOSSARY_MAX_CHARS);
        assert!(!capped.ends_with(","));
        // Kept the head.
        assert!(capped.starts_with("Prefixe : Nom0"));
    }

    #[test]
    fn locate_quote_finds_span() {
        let segs = vec![
            seg(0.0, 2.0, "Bonjour tout le monde"),
            seg(2.0, 5.0, "on parle du projet Atlas"),
            seg(5.0, 8.0, "avec le client Dupont"),
        ];
        let (s, e) = locate_quote("du projet Atlas", &segs);
        assert_eq!(s, Some(2.0));
        assert_eq!(e, Some(5.0));
    }

    #[test]
    fn locate_quote_absent_returns_none() {
        let segs = vec![seg(0.0, 2.0, "Bonjour tout le monde")];
        assert_eq!(locate_quote("phrase absente totalement", &segs), (None, None));
    }

    #[test]
    fn clarifications_actionable_ignores_context_only() {
        let mut c = Clarifications::default();
        c.context_additions.push(ContextAddition { fact: "Marie = cheffe".into() });
        assert!(!c.has_actionable());
        c.unassigned_tasks.push(UnassignedTask { task: "faire X".into(), question: "qui ?".into() });
        assert!(c.has_actionable());
    }
}
