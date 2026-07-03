//! Conversational Q&A over the note vault, using Claude with an agentic
//! tool-use loop: Claude decides what to `search_notes` and which notes to
//! `read_note`, then answers citing its sources. Reuses the vault keyword
//! scoring and the shared `call_claude_with_retry` HTTP helper.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::Emitter;
use ts_rs::TS;

use crate::keychain;

/// Cap on agentic rounds, to bound latency/cost.
const MAX_TOOL_ITERATIONS: usize = 6;
const SEARCH_RESULTS: usize = 6;
const SEARCH_EXCERPT_CHARS: usize = 240;
const READ_BODY_CHARS: usize = 4000;

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ChatMessage {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Serialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ChatSource {
    /// File stem — also the citation key used in [[wikilinks]].
    pub title: String,
    /// Absolute path, for opening the note directly.
    pub path: String,
}

#[derive(Debug, Serialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ChatResponse {
    pub answer: String,
    pub sources: Vec<ChatSource>,
}

const CHAT_SYSTEM: &str = r#"Tu es Alfred, l'assistant personnel de l'utilisateur. Tu réponds à ses questions en t'appuyant sur ses notes personnelles (un coffre de fichiers Markdown).

Méthode :
- Utilise l'outil `search_notes` pour trouver les notes pertinentes (fais plusieurs recherches avec des mots-clés différents si besoin).
- Utilise l'outil `read_note` pour lire en entier une note qui semble utile AVANT de t'en servir.
- Ne réponds qu'à partir de ce que disent réellement les notes. Si l'information ne s'y trouve pas, dis-le clairement, sans inventer.

Réponse finale :
- En français, concise et structurée en Markdown.
- Mets en **gras** les noms, dates et points clés.
- Cite chaque note source en reprenant son nom EXACT entre doubles crochets, par ex. [[Nom de la note]] — recopie-le à l'identique depuis le champ « Note » des résultats, car il sert de lien cliquable."#;

fn tools() -> Value {
    json!([
        {
            "name": "search_notes",
            "description": "Recherche dans le coffre de notes celles qui correspondent à une requête (mots-clés). Renvoie les meilleures notes avec un court extrait. Utilise des requêtes courtes et ciblées.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Mots-clés ou sujet à rechercher" }
                },
                "required": ["query"]
            }
        },
        {
            "name": "read_note",
            "description": "Lit le contenu complet d'une note, identifiée par son nom (tel que renvoyé par search_notes, sans guillemets) ou son chemin.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "note": { "type": "string", "description": "Nom exact de la note ou son chemin" }
                },
                "required": ["note"]
            }
        }
    ])
}

// ─── Vault tools (blocking I/O — run via spawn_blocking) ────────────────────────

fn is_md_entry(e: &walkdir::DirEntry) -> bool {
    e.file_type().is_file()
        && e.path().extension().map(|x| x == "md").unwrap_or(false)
        && !e
            .path()
            .components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
}

/// Returns up to SEARCH_RESULTS (stem, path, excerpt), best matches first.
fn search_vault(root: &Path, query: &str) -> Vec<(String, String, String)> {
    let keywords = super::extract_keywords(query, None);
    if keywords.is_empty() {
        return vec![];
    }

    let mut scored: Vec<(usize, String, String, String)> = vec![];

    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(is_md_entry)
        .take(5000)
    {
        let Ok(content) = std::fs::read_to_string(entry.path()) else { continue };
        let stem = entry
            .path()
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        let stem_lower = stem.to_lowercase();
        let content_lower = content.to_lowercase();

        let score: usize = keywords
            .iter()
            .map(|kw| {
                let in_title = if stem_lower.contains(kw.as_str()) { 5 } else { 0 };
                let in_body = content_lower.matches(kw.as_str()).count().min(10);
                in_title + in_body
            })
            .sum();

        if score > 0 {
            let (_, body) = crate::notes::frontmatter::parse(&content, &stem);
            let excerpt: String = body
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(SEARCH_EXCERPT_CHARS)
                .collect();
            scored.push((score, stem, entry.path().to_string_lossy().to_string(), excerpt));
        }
    }

    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored.truncate(SEARCH_RESULTS);
    scored.into_iter().map(|(_, s, p, e)| (s, p, e)).collect()
}

fn load_note(path: &Path) -> Option<(String, String, String)> {
    let content = std::fs::read_to_string(path).ok()?;
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let (_, body) = crate::notes::frontmatter::parse(&content, &stem);
    let body: String = body.chars().take(READ_BODY_CHARS).collect();
    Some((stem, path.to_string_lossy().to_string(), body))
}

/// Resolve a note by exact path, else by file stem (case-insensitive),
/// else by frontmatter title. Returns (stem, path, body).
fn read_note(root: &Path, note_ref: &str) -> Option<(String, String, String)> {
    let as_path = Path::new(note_ref);
    if as_path.is_file() && as_path.extension().map(|x| x == "md").unwrap_or(false) {
        return load_note(as_path);
    }

    let target = note_ref.trim().to_lowercase();
    let mut title_match: Option<PathBuf> = None;

    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(is_md_entry)
        .take(5000)
    {
        let stem = entry
            .path()
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        if stem.to_lowercase() == target {
            return load_note(entry.path());
        }

        if title_match.is_none() {
            if let Ok(content) = std::fs::read_to_string(entry.path()) {
                let (meta, _) = crate::notes::frontmatter::parse(&content, &stem);
                if meta.title.to_lowercase() == target {
                    title_match = Some(entry.path().to_path_buf());
                }
            }
        }
    }

    title_match.and_then(|p| load_note(&p))
}

fn extract_text(content: &[Value]) -> String {
    content
        .iter()
        .filter_map(|b| if b["type"] == "text" { b["text"].as_str() } else { None })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

// ─── Agentic loop ───────────────────────────────────────────────────────────────

pub async fn answer_question(
    question: String,
    history: Vec<ChatMessage>,
    vault_root: Option<PathBuf>,
    app: &tauri::AppHandle,
) -> Result<ChatResponse> {
    let api_key = keychain::get_secret("claude_api_key")?
        .filter(|k| !k.is_empty())
        .ok_or_else(|| anyhow!("Clé API Claude non configurée. Ajoutez-la dans Réglages → IA."))?;

    let root = vault_root
        .ok_or_else(|| anyhow!("Aucun coffre de notes configuré. Choisissez-en un dans Réglages → Notes."))?;

    let client = reqwest::Client::new();

    let mut messages: Vec<Value> = Vec::new();
    for m in &history {
        let role = if m.role == "assistant" { "assistant" } else { "user" };
        messages.push(json!({ "role": role, "content": m.content }));
    }
    messages.push(json!({ "role": "user", "content": question }));

    let tools = tools();
    let mut sources: Vec<ChatSource> = Vec::new();

    for _ in 0..MAX_TOOL_ITERATIONS {
        let body = json!({
            "model": super::MODEL,
            "max_tokens": 1500,
            "system": [{
                "type": "text",
                "text": CHAT_SYSTEM,
                "cache_control": {"type": "ephemeral"}
            }],
            "tools": tools,
            "messages": messages,
        });

        let resp = super::call_claude_with_retry(&client, &api_key, &body).await?;

        let content = resp["content"].as_array().cloned().unwrap_or_default();
        let stop_reason = resp["stop_reason"].as_str().unwrap_or("");

        if stop_reason != "tool_use" {
            return Ok(ChatResponse { answer: extract_text(&content), sources });
        }

        // Record the assistant's tool-use turn verbatim before answering it.
        messages.push(json!({ "role": "assistant", "content": content }));

        let mut tool_results: Vec<Value> = Vec::new();
        for block in &content {
            if block["type"] != "tool_use" {
                continue;
            }
            let tool_use_id = block["id"].as_str().unwrap_or("").to_string();
            let name = block["name"].as_str().unwrap_or("");
            let input = &block["input"];

            let result_text = match name {
                "search_notes" => {
                    let query = input["query"].as_str().unwrap_or("").to_string();
                    let _ = app.emit("chat-progress", json!({ "kind": "search", "label": query }));
                    let (r, q) = (root.clone(), query.clone());
                    let hits = tokio::task::spawn_blocking(move || search_vault(&r, &q))
                        .await
                        .unwrap_or_default();
                    if hits.is_empty() {
                        "Aucune note ne correspond à cette recherche.".to_string()
                    } else {
                        hits.iter()
                            .enumerate()
                            .map(|(i, (stem, _path, excerpt))| {
                                format!("{}. Note: \"{}\"\n   Extrait: {}", i + 1, stem, excerpt)
                            })
                            .collect::<Vec<_>>()
                            .join("\n\n")
                    }
                }
                "read_note" => {
                    let note_ref = input["note"].as_str().unwrap_or("").to_string();
                    let _ = app.emit("chat-progress", json!({ "kind": "read", "label": note_ref }));
                    let (r, nr) = (root.clone(), note_ref.clone());
                    match tokio::task::spawn_blocking(move || read_note(&r, &nr))
                        .await
                        .unwrap_or(None)
                    {
                        Some((stem, path, body)) => {
                            if !sources.iter().any(|s| s.path == path) {
                                sources.push(ChatSource { title: stem.clone(), path });
                            }
                            format!("Note: \"{}\"\n\n{}", stem, body)
                        }
                        None => format!("Note introuvable : {}", note_ref),
                    }
                }
                other => format!("Outil inconnu : {}", other),
            };

            tool_results.push(json!({
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": result_text
            }));
        }

        if tool_results.is_empty() {
            break;
        }
        messages.push(json!({ "role": "user", "content": tool_results }));
    }

    // Iterations exhausted — force a final answer with no further tool calls.
    let body = json!({
        "model": super::MODEL,
        "max_tokens": 1500,
        "system": CHAT_SYSTEM,
        "messages": messages,
    });
    let resp = super::call_claude_with_retry(&client, &api_key, &body).await?;
    let content = resp["content"].as_array().cloned().unwrap_or_default();
    let answer = extract_text(&content);
    Ok(ChatResponse {
        answer: if answer.is_empty() {
            "Je n'ai pas pu produire de réponse.".to_string()
        } else {
            answer
        },
        sources,
    })
}
