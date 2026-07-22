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

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
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
    /// Action en lot / écrasement proposée par Claude, en attente de
    /// confirmation utilisateur (spec/22) — absente pour un tour normal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_action: Option<super::agent_actions::ProposedAction>,
}

/// Base du system prompt, alignée sur `app_language` (spec/21/22) — un schéma
/// d'outils tout-français tire Claude vers le FR même avec une bonne consigne
/// de langue (constat spec/05/17). La consigne de langue de LA RÉPONSE reste
/// séparée (`language_instruction`, inférée depuis la question) : ceci ne
/// fixe que la langue des DÉFINITIONS d'outils / instructions statiques.
fn chat_system(lang: &str) -> String {
    if lang == "en" {
        r#"You are Alfred, the user's personal assistant. You answer their questions and can ACT on their notes vault and tasks, using the tools provided.

Reading method:
- Use `search_notes` to find relevant notes (run several searches with different keywords if needed).
- Use `read_note` to read a note in full BEFORE relying on it.
- Only answer from what the notes actually say. If the information isn't there, say so clearly, never invent it.

Action tools (notes and tasks):
- You can create/edit/archive notes (create_note, append_to_note, update_note_metadata, archive_note, unarchive_note, rename_note) and tasks (create_task, complete_task, move_task, update_task, dismiss_task).
- Golden rule: you NEVER truly delete anything. Any "delete" intent becomes a reversible ARCHIVE (archive_note / dismiss_task) — never a file deletion.
- UNITARY actions (a single item, non-destructive): apply them directly, then report the result in your answer.
- BULK actions (several items at once) or a FULL REWRITE of existing content: use ONLY the dedicated tools (archive_notes_bulk, unarchive_notes_bulk, dismiss_tasks_bulk, rewrite_note_body) — they never execute immediately, a confirmation card is shown to the user instead. Briefly explain what you're proposing in your answer while the card is shown.
- Never use those bulk/rewrite tools for a simple addition — append_to_note handles additions directly, no confirmation needed.
- The 4 task columns are stored in FRENCH in the file regardless of the app's language (À faire/En cours/Fait/Archivé — known technical limitation). When you mention them to the user, ALWAYS translate them into the language of your answer (e.g. "Fait" → "Done") — never quote the raw file label.

Final answer:
- Concise, structured Markdown, in the same language as the question (see the language instruction below as a fallback).
- **Bold** names, dates, and key points.
- Cite each source note by its EXACT name in double brackets, e.g. [[Note name]] — copy it verbatim from the "Note" field of the results, since it acts as a clickable link."#
    } else {
        r#"Tu es Alfred, l'assistant personnel de l'utilisateur. Tu réponds à ses questions et tu peux AGIR sur son coffre de notes et ses tâches, en t'appuyant sur les outils fournis.

Méthode de lecture :
- Utilise l'outil `search_notes` pour trouver les notes pertinentes (fais plusieurs recherches avec des mots-clés différents si besoin).
- Utilise l'outil `read_note` pour lire en entier une note qui semble utile AVANT de t'en servir.
- Ne réponds qu'à partir de ce que disent réellement les notes. Si l'information ne s'y trouve pas, dis-le clairement, sans inventer.

Outils d'action (notes et tâches) :
- Tu peux créer/éditer/archiver des notes (create_note, append_to_note, update_note_metadata, archive_note, unarchive_note, rename_note) et des tâches (create_task, complete_task, move_task, update_task, dismiss_task).
- Règle d'or : tu NE SUPPRIMES JAMAIS RIEN pour de vrai. Toute intention de « suppression » se traduit par un ARCHIVAGE réversible (archive_note / dismiss_task) — jamais par une suppression de fichier.
- Actions UNITAIRES (un seul élément, non destructives) : applique-les directement, puis rends compte du résultat dans ta réponse.
- Actions en LOT (plusieurs éléments à la fois) ou RÉÉCRITURE COMPLÈTE d'un contenu existant : n'utilise QUE les outils dédiés (archive_notes_bulk, unarchive_notes_bulk, dismiss_tasks_bulk, rewrite_note_body) — ils ne s'exécutent jamais immédiatement, une carte de confirmation est affichée à l'utilisateur à la place. Explique brièvement ce que tu proposes dans ta réponse pendant que la carte s'affiche.
- N'utilise jamais ces outils lot/écrasement pour un simple ajout — append_to_note gère les ajouts directement, sans confirmation.
- Les 4 colonnes de tâches sont stockées en français dans le fichier QUELLE QUE SOIT la langue de l'app (À faire/En cours/Fait/Archivé — limitation technique connue). Quand tu en parles à l'utilisateur, traduis-les TOUJOURS dans la langue de ta réponse (ex. « Fait » → « Done » en anglais) — ne recopie jamais le libellé brut du fichier.

Réponse finale :
- Concise et structurée en Markdown, dans la même langue que la question (voir consigne de langue ci-dessous si besoin d'un repli).
- Mets en **gras** les noms, dates et points clés.
- Cite chaque note source en reprenant son nom EXACT entre doubles crochets, par ex. [[Nom de la note]] — recopie-le à l'identique depuis le champ « Note » des résultats, car il sert de lien cliquable."#
    }
    .to_string()
}

fn tools(lang: &str) -> Value {
    let en = lang == "en";
    let mut base = vec![
        json!({
            "name": "search_notes",
            "description": if en { "Searches the notes vault for keyword matches. Returns the best notes with a short excerpt. Use short, focused queries." } else { "Recherche dans le coffre de notes celles qui correspondent à une requête (mots-clés). Renvoie les meilleures notes avec un court extrait. Utilise des requêtes courtes et ciblées." },
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": if en { "Keywords or topic to search for" } else { "Mots-clés ou sujet à rechercher" } }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "read_note",
            "description": if en { "Reads a note's full content, identified by its name (as returned by search_notes, without quotes) or its path." } else { "Lit le contenu complet d'une note, identifiée par son nom (tel que renvoyé par search_notes, sans guillemets) ou son chemin." },
            "input_schema": {
                "type": "object",
                "properties": {
                    "note": { "type": "string", "description": if en { "Exact note name or its path" } else { "Nom exact de la note ou son chemin" } }
                },
                "required": ["note"]
            }
        }),
    ];
    base.extend(super::agent_actions::tool_defs(lang));
    Value::Array(base)
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
/// else by frontmatter title. Returns (stem, path, body). Delegates to
/// `agent_actions::resolve_note_path`, which additionally guarantees the
/// resolved path never escapes `root` (spec/22 garde-fou — a literal
/// out-of-vault path used to be accepted unchecked here).
fn read_note(root: &Path, note_ref: &str) -> Option<(String, String, String)> {
    super::agent_actions::resolve_note_path(root, note_ref).and_then(|p| load_note(&p))
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
    db: &sqlx::SqlitePool,
    app: &tauri::AppHandle,
) -> Result<ChatResponse> {
    let access = super::resolve_access(db).await?;

    let root = vault_root
        .ok_or_else(|| anyhow!("Aucun coffre de notes configuré. Choisissez-en un dans Réglages → Notes."))?;

    let client = reqwest::Client::new();
    let lang = if super::app_language(db).await == "en" { "en" } else { "fr" };
    let system_text = format!("{}\n{}", chat_system(lang), super::language_instruction(db).await);

    let mut messages: Vec<Value> = Vec::new();
    for m in &history {
        let role = if m.role == "assistant" { "assistant" } else { "user" };
        messages.push(json!({ "role": role, "content": m.content }));
    }
    messages.push(json!({ "role": "user", "content": question }));

    let tools = tools(lang);
    let mut sources: Vec<ChatSource> = Vec::new();

    for _ in 0..MAX_TOOL_ITERATIONS {
        let body = json!({
            "model": super::MODEL,
            "max_tokens": 1500,
            "system": [{
                "type": "text",
                "text": &system_text,
                "cache_control": {"type": "ephemeral"}
            }],
            "tools": tools,
            "messages": messages,
        });

        let resp = super::call_claude_with_retry(&client, &access, &body).await?;

        let content = resp["content"].as_array().cloned().unwrap_or_default();
        let stop_reason = resp["stop_reason"].as_str().unwrap_or("");

        if stop_reason != "tool_use" {
            return Ok(ChatResponse { answer: extract_text(&content), sources, pending_action: None });
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

            // Lot / écrasement (spec/22) : jamais exécuté ici — dès qu'une
            // proposition est construite, on s'arrête et on la renvoie au
            // front (carte Appliquer/Annuler, pas de round-trip vers Claude).
            if super::agent_actions::is_confirm_required(name) {
                match super::agent_actions::build_proposal(name, input, &root, db, lang).await {
                    Ok(action) => {
                        let answer = {
                            let text = extract_text(&content);
                            if text.is_empty() { action.summary.clone() } else { text }
                        };
                        return Ok(ChatResponse { answer, sources, pending_action: Some(action) });
                    }
                    Err(e) => {
                        tool_results.push(json!({
                            "type": "tool_result",
                            "tool_use_id": tool_use_id,
                            "content": e.to_string(),
                        }));
                        continue;
                    }
                }
            }

            let result_text = match name {
                "search_notes" => {
                    let query = input["query"].as_str().unwrap_or("").to_string();
                    let _ = app.emit("chat-progress", json!({ "kind": "search", "label": query }));
                    let (r, q) = (root.clone(), query.clone());
                    let hits = tokio::task::spawn_blocking(move || search_vault(&r, &q))
                        .await
                        .unwrap_or_default();
                    if hits.is_empty() {
                        if lang == "en" { "No note matches this search.".to_string() } else { "Aucune note ne correspond à cette recherche.".to_string() }
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
                        None => if lang == "en" { format!("Note not found: {}", note_ref) } else { format!("Note introuvable : {}", note_ref) },
                    }
                }
                other if super::agent_actions::is_unitary_agent_tool(other) => {
                    let _ = app.emit("chat-progress", json!({ "kind": "action", "label": other }));
                    super::agent_actions::execute_unitary(other, input, &root, db, app, lang).await
                }
                other => if lang == "en" { format!("Unknown tool: {}", other) } else { format!("Outil inconnu : {}", other) },
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
        "system": &system_text,
        "messages": messages,
    });
    let resp = super::call_claude_with_retry(&client, &access, &body).await?;
    let content = resp["content"].as_array().cloned().unwrap_or_default();
    let answer = extract_text(&content);
    Ok(ChatResponse {
        answer: if answer.is_empty() {
            if lang == "en" { "I couldn't produce an answer.".to_string() } else { "Je n'ai pas pu produire de réponse.".to_string() }
        } else {
            answer
        },
        sources,
        pending_action: None,
    })
}
