use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::SqlitePool;
use std::path::Path;
use tauri::Emitter;
use ts_rs::TS;

use crate::keychain;
use crate::notes::todo_md::IngestTask;

pub mod agent_actions;
pub mod chat;
pub mod chat_history;
pub mod pending_clarifications;

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

/// Instruction de langue des sorties IA (spec/21 — indépendante de la langue
/// de l'UI) : Alfred rédige dans la langue du contenu qu'on lui donne
/// (transcription/question) — Claude infère très bien ça seul depuis le
/// texte — et ne se rabat sur `app_language` (config, défaut `fr`) qu'en cas
/// d'ambiguïté (transcription trop courte, multilingue, etc.).
/// `app_language` config value, defaulting to `"fr"` — the app's UI language,
/// reused as a fallback default wherever content produced by our own Rust
/// code (not Claude) needs a language, distinct from the language of the
/// content itself (spec/21).
pub async fn app_language(db: &SqlitePool) -> String {
    sqlx::query_scalar("SELECT value FROM config WHERE key = 'app_language'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "fr".to_string())
}

async fn language_instruction(db: &SqlitePool) -> String {
    let app_language = app_language(db).await;
    let fallback = if app_language == "en" { "English" } else { "French" };
    format!(
        "- Langue de la réponse : écris dans la MÊME langue que le texte fourni (transcription ou question) ; si cette langue est ambiguë ou indéterminable, réponds en {}.",
        fallback
    )
}

/// Langue à cibler pour UNE sortie IA dérivée d'une transcription PRÉCISE
/// (analyse, contexte, ingestion) — spec/05/17, 2e test tranché. Contrairement
/// à `language_instruction` (INFÉRENCE : Claude devine depuis le texte, avec
/// replis vers `app_language` seulement si ambigu), celle-ci lit la langue
/// RÉELLEMENT détectée par Whisper (`transcriptions.language`, spec/04) pour
/// ce `recording_id` précis — l'inférence dérivait vers le français malgré une
/// transcription confirmée EN (preuve `/resolve`, citation d'origine anglaise
/// mais propositions/faits rédigés en français). `recording_id: None` (ex.
/// ré-ingestion d'une note libre sans transcription liée, spec/05) retombe sur
/// `app_language`. Seules `"en"`/`"fr"` sont ciblées (v1 = FR/EN uniquement,
/// spec/21) ; whisper.cpp renvoie des codes ISO-639-1 deux lettres.
async fn recording_language(db: &SqlitePool, recording_id: Option<&str>) -> &'static str {
    if let Some(id) = recording_id {
        let detected: Option<String> = sqlx::query_scalar("SELECT language FROM transcriptions WHERE recording_id = ?")
            .bind(id)
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
        if let Some(code) = detected {
            return if code == "en" { "en" } else { "fr" };
        }
    }
    if app_language(db).await == "en" { "en" } else { "fr" }
}

/// Consigne de langue IMPÉRATIVE dérivée de `recording_language` — pas une
/// inférence proposée à Claude, une DIRECTIVE. « Write ALL fields / your
/// entire answer in {lang} » plutôt que « écris dans la langue du texte » :
/// le premier libellé n'a laissé aucune place à une dérive vers le français
/// en test, le second en laissait (spec/05/17).
fn language_directive(lang: &str) -> &'static str {
    if lang == "en" {
        "- Language: write ALL fields / your entire answer in English. This is not optional, regardless of the language used elsewhere in this prompt."
    } else {
        "- Langue : rédige TOUS les champs / ta réponse entière en français. Ce n'est pas optionnel, quelle que soit la langue employée ailleurs dans ce prompt."
    }
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
- `titre` : un SUJET COURT qui nomme l'échange (ex. « Réunion Flexiflit — migration GKE », « Point équipe produit »). C'est le nom de fichier du compte-rendu : descriptif, concis (≤ 60 caractères), sans date. Chaîne vide si la transcription est inexploitable.
- `resume` : compte-rendu structuré en Markdown (points clés abordés), concis, dans la même langue que la transcription (voir consigne de langue ci-dessous si besoin d'un repli).
- `points_cles` : liste des points clés abordés, en phrases courtes.
- `taches` : chaque tâche à faire identifiée dans la transcription. Quand un responsable est nommé (prénom), rappelle-le dans `responsable` — c'est important, ne l'invente pas s'il n'est pas mentionné. `echeance` au format YYYY-MM-DD si une date est mentionnée, sinon omets-la.
- `participants` : les prénoms des personnes présentes / citées comme participant à l'échange (pas les personnes simplement mentionnées). Liste vide si indéterminable.
- `project` : la liste des projets concernés (0, 1 ou plusieurs), UNIQUEMENT ceux clairement identifiables (nommés dans la transcription ou reconnaissables via le contexte interne). Liste vide sinon — ne devine pas.
- N'invente rien : si la transcription est trop courte ou vide de contenu exploitable, renvoie un résumé bref, une liste de points clés vide, et aucune tâche."#;

/// Schéma du tool — les DESCRIPTIONS de champs suivent `lang` (spec/05/17, 2e
/// test tranché) : un schéma tout-français tirait Claude vers le français même
/// avec une bonne consigne système. Les NOMS de champs (`titre`, `resume`…)
/// restent inchangés, quelle que soit `lang` — ce sont des clés internes lues
/// par `IngestionOutput` (serde), pas du texte affiché.
fn ingestion_tool(lang: &str) -> serde_json::Value {
    let en = lang == "en";
    json!([{
        "name": "submit_ingestion",
        "description": if en { "Submit the structured summary of the transcription and the identified tasks." } else { "Soumets le compte-rendu structuré de la transcription et les tâches identifiées." },
        "input_schema": {
            "type": "object",
            "properties": {
                "titre": {
                    "type": "string",
                    "description": if en { "Short subject of the exchange — filename of the summary (no date). Empty if unusable." } else { "Sujet court de l'échange — nom de fichier du compte-rendu (sans date). Vide si inexploitable." }
                },
                "resume": {
                    "type": "string",
                    "description": if en { "Structured summary in Markdown" } else { "Compte-rendu structuré en Markdown" }
                },
                "points_cles": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": if en { "Key points covered" } else { "Points clés abordés" }
                },
                "taches": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "titre": { "type": "string" },
                            "responsable": { "type": "string", "description": if en { "First name of the owner, if identifiable" } else { "Prénom du responsable, si identifiable" } },
                            "echeance": { "type": "string", "description": if en { "YYYY-MM-DD, if mentioned" } else { "YYYY-MM-DD, si mentionnée" } }
                        },
                        "required": ["titre"]
                    },
                    "description": if en { "Tasks identified in the transcription" } else { "Tâches identifiées dans la transcription" }
                },
                "participants": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": if en { "First names of participants in the exchange" } else { "Prénoms des participants à l'échange" }
                },
                "project": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": if en { "Projects concerned (0..n), only if clearly identifiable" } else { "Projets concernés (0..n), seulement s'ils sont clairement identifiables" }
                }
            },
            "required": ["titre", "resume", "points_cles", "taches"]
        }
    }])
}

#[derive(Debug, Deserialize)]
struct IngestionOutput {
    /// Sujet court (spec/05/07) → nom du fichier compte-rendu. Vide → nom daté.
    #[serde(default)]
    titre: String,
    resume: String,
    #[serde(default)]
    points_cles: Vec<String>,
    #[serde(default)]
    taches: Vec<IngestedTask>,
    #[serde(default)]
    participants: Vec<String>,
    /// Liste de projets (0..n) — une réunion peut relever de plusieurs projets.
    #[serde(default, deserialize_with = "string_or_seq")]
    project: Vec<String>,
}

/// Accepte `"Acme"` comme `["Acme"]` — l'IA rend parfois un scalaire malgré le
/// schéma array ; on ne perd pas l'ingestion pour ça.
fn string_or_seq<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum V {
        One(String),
        Many(Vec<String>),
    }
    Ok(match V::deserialize(d)? {
        V::One(s) => vec![s],
        V::Many(v) => v,
    })
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
/// `want_tasks: false` (spec/05 « sortie découplée ») → the prompt asks for an
/// empty `taches` list (the tool schema is unchanged; Rust won't write tasks
/// either way, this just avoids paying for output we'll drop).
async fn call_ingestion(
    text: &str,
    context: Option<&str>,
    want_tasks: bool,
    recording_id: Option<&str>,
    db: &SqlitePool,
) -> Result<(IngestionOutput, &'static str)> {
    let access = resolve_access(db).await?;
    let client = reqwest::Client::new();

    let mut system_prompt = if want_tasks {
        INGESTION_SYSTEM.to_string()
    } else {
        format!(
            "{}\n- IMPORTANT : l'utilisateur n'a PAS demandé l'extraction de tâches — renvoie `taches` comme liste vide, quoi que contienne la transcription.",
            INGESTION_SYSTEM
        )
    };
    let lang = recording_language(db, recording_id).await;
    system_prompt.push_str(&format!("\n{}", language_directive(lang)));

    let body = json!({
        "model": MODEL,
        "max_tokens": 4096,
        "thinking": {"type": "disabled"},
        "system": system_blocks(&system_prompt, context),
        "tools": ingestion_tool(lang),
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

/// Shared engine: run the ingestion call, then write ONLY the requested sections
/// (spec/05 « sortie découplée ») — Rust does the writing, never the AI.
/// `recording_id` is `None` when re-ingesting a note that isn't linked to a
/// recording (spec/05 "note_path" entry point). `summary=false && tasks=false`
/// → no AI call at all (only the transcription exists).
async fn run_ingestion_core(
    text: &str,
    note_title: &str,
    recording_id: Option<&str>,
    summary: bool,
    tasks: bool,
    db: &SqlitePool,
    vault_root: Option<&Path>,
    app_handle: &tauri::AppHandle,
) -> Result<()> {
    // `ingestion-status-changed` (spec/13's guided tour + error surfacing) needs
    // an unambiguous done/error signal — `notes-updated`/`todos-updated` are too
    // generic (they can fire for unrelated reasons) to reliably drive UI waiting
    // on ingestion. Errors carry their message: a silent ingestion failure looks
    // exactly like "the feature doesn't work" (learned the hard way in testing).
    // La `phase` (spec/05/10 — `analyzing` → `summary` → `tasks` → `done`) pilote
    // la capsule majordome (« Je cogite… » / « Je note les tâches… »). Un seul
    // appel IA : les phases d'écriture sont brèves mais honnêtes.
    let emit_status = |status: &str, phase: &str, message: Option<String>| {
        let _ = app_handle.emit(
            "ingestion-status-changed",
            json!({ "status": status, "phase": phase, "recording_id": recording_id, "message": message }),
        );
    };

    if text.trim().is_empty() || (!summary && !tasks) {
        emit_status("done", "done", None);
        return Ok(());
    }

    emit_status("running", "analyzing", None);

    // Contexte interne (spec/16) : helps the ingestion spell names/teams right.
    let context = match vault_root {
        Some(root) => crate::notes::context::read_context(root, db).await,
        None => None,
    };

    let (output, ai_mode) = match call_ingestion(text, context.as_deref(), tasks, recording_id, db).await {
        Ok(r) => r,
        Err(e) => {
            emit_status("error", "error", Some(e.to_string()));
            let msg: String = e.to_string().chars().take(200).collect();
            crate::metrics::send("ingestion_failed", json!({ "error": msg }));
            return Err(e);
        }
    };

    // Nom du compte-rendu = sujet court fourni par l'IA (spec/05/07) ; la
    // transcription brute garde son nom daté. Fallback : nom daté si titre vide.
    let report_title = {
        let t = output.titre.trim();
        if t.is_empty() { note_title.to_string() } else { t.to_string() }
    };
    let report_date = chrono::Local::now().format("%Y-%m-%d").to_string();

    if let Some(vault_root) = vault_root {
        // 1. Compte-rendu → alfred-intelligence/{titre}.md — only when requested.
        if summary {
            emit_status("running", "summary", None);
            let folder = vault_root.join(intelligence_folder(db).await);
            let project: Vec<String> = output
                .project
                .iter()
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect();
            let metadata = crate::notes::NoteMetadata::for_meeting_report(&report_title, recording_id, output.participants.clone(), project);
            let mut body = output.resume.clone();
            if !output.points_cles.is_empty() {
                // Titre généré par NOTRE code (pas par Claude) — localisé selon
                // `app_language` (spec/05/21), indépendamment de la langue dans
                // laquelle Claude a rédigé le corps du compte-rendu.
                let heading = if app_language(db).await == "en" { "Key points" } else { "Points clés" };
                body.push_str(&format!("\n\n## {}\n", heading));
                for p in &output.points_cles {
                    body.push_str(&format!("- {}\n", p));
                }
            }
            // Liste des tâches extraites, avec lien profond `task:` cliquable
            // (spec/23) → complète le lien inverse déjà posé sur la ligne de
            // Todo.md (provenance `[[compte-rendu]]`, spec/05/06) : la paire
            // devient navigable dans les deux sens. Seulement quand les tâches
            // sont réellement écrites (`tasks`) — sinon ces liens seraient
            // morts (rien dans Todo.md à cette identité).
            if tasks && !output.taches.is_empty() {
                let heading = if app_language(db).await == "en" { "Tasks" } else { "Tâches" };
                body.push_str(&format!("\n\n## {}\n", heading));
                for task in &output.taches {
                    let id = crate::notes::todo_md::normalize_title(&task.titre);
                    body.push_str(&format!("- [{}](task:{})\n", task.titre, urlencoding::encode(&id)));
                }
            }
            match crate::notes::vault::create_intelligence_note(&folder, &report_title, metadata, &body).await {
                Ok(ref note) => {
                    eprintln!("[ingestion] compte-rendu created: {}", report_title);
                    // Pastille (spec/10, feedback tests) : déplace la cible —
                    // et donc le point ambre — de la note brute vers le
                    // compte-rendu maintenant qu'il existe. Émission dédiée
                    // (plutôt qu'étendre `emit_status`) : c'est le seul point
                    // du pipeline où le chemin du compte-rendu est connu.
                    let _ = app_handle.emit(
                        "ingestion-status-changed",
                        json!({ "status": "running", "phase": "summary", "recording_id": recording_id, "message": None::<String>, "report_path": note.path }),
                    );
                    // Archivage de la transcription brute (spec/05/07) : le
                    // compte-rendu a rempli son rôle, seulement quand un
                    // `recording_id` existe (pas d'appel manuel/texte libre).
                    if let Some(recording_id) = recording_id {
                        let recording_folder = crate::transcription::recording_folder(db).await;
                        crate::notes::vault::archive_raw_note_by_recording_id(vault_root, &recording_folder, recording_id).await;
                    }
                }
                Err(e) => eprintln!("[ingestion] failed to write compte-rendu: {}", e),
            }
        }

        // 2. Tâches → Todo.md (spec/06 — the todos source of truth), deduped —
        //    only when requested.
        if tasks && !output.taches.is_empty() {
            emit_status("running", "tasks", None);
            let todo_rel_path = crate::todos::todo_file_path(db).await;
            // Projet principal de la réunion (spec/06) : posé en `+Projet` sur
            // chaque tâche extraite — la ligne ne porte qu'un marqueur, on
            // prend le premier projet identifié quand il y en a plusieurs.
            let main_project = output
                .project
                .iter()
                .map(|p| p.trim())
                .find(|p| !p.is_empty())
                .map(str::to_string);
            let tasks: Vec<IngestTask> = output
                .taches
                .iter()
                .map(|t| IngestTask {
                    titre: t.titre.clone(),
                    responsable: t.responsable.clone(),
                    echeance: t.echeance.clone(),
                    project: main_project.clone(),
                })
                .collect();
            // Provenance (spec/05/06 « fiche tâche ») : wikilink + date sur la
            // ligne, pour retrouver d'où vient une tâche. Pointe vers le
            // compte-rendu (nommé par sujet) quand il est réellement écrit
            // (summary=true) ; sinon vers la note brute de transcription
            // (toujours écrite) — jamais un lien mort.
            let provenance_title = if summary { report_title.as_str() } else { note_title };
            let provenance = Some((provenance_title, report_date.as_str()));
            match crate::notes::todo_md::append_tasks(vault_root, &todo_rel_path, &tasks, provenance).await {
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
    emit_status("done", "done", None);

    Ok(())
}

/// Automatic trigger, right after `transcription-complete` (spec/05). **RÉVISÉ**
/// (spec/17 §3, feedback tests — revient sur « toujours `/resolve` ») : si
/// l'analyse ne relève **aucun** point à vérifier (fix/tâche sans responsable/
/// phrase floue), on finalise directement — l'écran `/resolve` n'est présenté
/// que quand il y a réellement quelque chose à trancher. Les `context_additions`
/// (auto « Appris ») ne comptent jamais comme « à vérifier » : ils sont toujours
/// écrits, avec ou sans clarifications.
pub async fn run_ingestion_for_recording(
    recording_id: &str,
    transcription_text: &str,
    note_title: &str,
    summary: bool,
    tasks: bool,
    db: &SqlitePool,
    vault_root: Option<&Path>,
    app_handle: &tauri::AppHandle,
) -> Result<()> {
    // Analyse d'abord. Un échec d'analyse retombe sur l'ingestion directe — on ne
    // perd jamais le compte-rendu pour une panne de l'analyse, mais ce repli
    // reste une résilience d'erreur, pas un raccourci produit : il saute la
    // vérification uniquement quand celle-ci n'a pas pu avoir lieu.
    //
    // Pastille (spec/10, feedback tests) : cette analyse tournait jusqu'ici en
    // silence — aucun statut émis entre `transcription-complete` et
    // `clarifications-ready`. `phase: "verifying"` distingue ce moment de
    // celui, plus tardif, de `run_ingestion_core` (même mot « analyzing » pour
    // une étape différente — la relecture post-correction). La cible reste la
    // note brute (déjà posée par `transcription-complete`), inchangée ici.
    let _ = app_handle.emit(
        "ingestion-status-changed",
        json!({ "status": "running", "phase": "verifying", "recording_id": recording_id, "message": None::<String> }),
    );

    let context = match vault_root {
        Some(root) => crate::notes::context::read_context(root, db).await,
        None => None,
    };
    let clarifications = match call_analyze(transcription_text, context.as_deref(), recording_id, db).await {
        Ok(mut c) => {
            let segments = fetch_segments(recording_id, db).await.unwrap_or_default();
            fill_timestamps(&mut c, &segments);
            c
        }
        Err(e) => {
            eprintln!("[analyze] failed, falling back to direct ingestion: {}", e);
            return run_ingestion_core(transcription_text, note_title, Some(recording_id), summary, tasks, db, vault_root, app_handle).await;
        }
    };

    let needs_review = !clarifications.transcription_fixes.is_empty()
        || !clarifications.unassigned_tasks.is_empty()
        || !clarifications.unclear_sentences.is_empty();

    if !needs_review {
        // Rien à trancher (spec/17 §3, révisé) : finalise directement sur le
        // texte brut — les faits appris (context_additions) sont toujours
        // écrits par `finalize_ingestion`, qu'il y ait eu clarification ou non.
        let context_additions: Vec<String> = clarifications.context_additions.iter().map(|c| c.fact.clone()).collect();
        return finalize_ingestion(recording_id, transcription_text, note_title, context_additions, summary, tasks, db, vault_root, app_handle).await;
    }

    // Persisté par `recording_id` (spec/17 §3/spec/07, feedback tests) — survit à
    // la navigation, à un enregistrement suivant et à un redémarrage ; plusieurs
    // vérifications en attente coexistent. `clarifications-ready` reste émis pour
    // le chemin "on vient de finir un enregistrement, on ouvre tout de suite" ;
    // l'indicateur sur la note (arbre/Récents) couvre le cas où l'utilisateur a
    // navigué ailleurs entre-temps.
    if let Err(e) = pending_clarifications::save(db, recording_id, note_title, transcription_text, &clarifications, summary, tasks).await {
        eprintln!("[analyze] failed to persist pending clarifications: {}", e);
    }
    let _ = app_handle.emit("pending-clarifications-changed", json!({}));

    let _ = app_handle.emit(
        "clarifications-ready",
        json!({
            "recording_id": recording_id,
            "note_title": note_title,
            "text": transcription_text,
            "clarifications": clarifications,
            "summary": summary,
            "tasks": tasks,
        }),
    );
    Ok(())
}

/// Manual "ré-ingérer" trigger, relaunched on a specific `alfred-raw/` note
/// (spec/05). Reads the note's body (frontmatter stripped) and, if the note
/// already carries a `recording_id`, keeps that link.
pub async fn run_ingestion_for_note(
    note_path: &Path,
    summary: bool,
    tasks: bool,
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

    run_ingestion_core(&body, &metadata.title, metadata.recording_id.as_deref(), summary, tasks, db, vault_root, app_handle).await
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

const ANALYZE_SYSTEM: &str = r#"Tu es Alfred. On te donne la transcription brute d'un enregistrement (réunion, note vocale, appel) et, éventuellement, le contexte interne de l'utilisateur (entreprise, équipe, vocabulaire). AVANT de rédiger le compte-rendu, tu repères ce qui mérite une VALIDATION humaine. Soumets tes propositions via l'outil `submit_clarifications`.

Sois SÉLECTIF : ne remonte que ce qui est vraiment utile (haute confiance ou vraie importance). Si tout est clair, renvoie des listes vides — c'est un cas normal et souhaitable.

- `transcription_fixes` : un passage probablement MAL TRANSCRIT que tu sais corriger UNIQUEMENT parce que le contexte interne te donne le bon référent (ex. un prénom, un nom de projet, un terme métier). `quote` = le passage douteux recopié mot pour mot depuis la transcription ; `correction` = la version corrigée ; `confidence` entre 0 et 1. N'invente JAMAIS une correction sans référent dans le contexte.
- `unassigned_tasks` : une tâche à faire clairement énoncée mais SANS responsable identifiable. `task` = la tâche ; `question` = la question à poser (ex. « Qui s'en charge ? »).
- `unclear_sentences` : une phrase IMPORTANTE mais floue/ambiguë. `quote` = la phrase ; `proposed` = ta compréhension proposée.
- `context_additions` : un fait durable appris sur l'univers de l'utilisateur (ex. « Marie = cheffe de projet », « le projet Atlas concerne le client Dupont »). `fact` = le fait, en une ligne."#;

fn analyze_tool(lang: &str) -> serde_json::Value {
    let en = lang == "en";
    json!([{
        "name": "submit_clarifications",
        "description": if en { "Submit the points to validate before finalizing the summary." } else { "Soumets les points à valider avant de finaliser le compte-rendu." },
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
                            "confidence": { "type": "number", "description": if en { "0 to 1" } else { "0 à 1" } }
                        },
                        "required": ["quote", "correction"]
                    },
                    "description": if en { "Likely mis-transcribed passages you can confidently correct" } else { "Passages probablement mal transcrits que tu peux corriger avec confiance" }
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
                    },
                    "description": if en { "Clearly stated tasks with no identifiable owner" } else { "Tâches clairement énoncées sans responsable identifiable" }
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
                    },
                    "description": if en { "Important but unclear/ambiguous sentences" } else { "Phrases importantes mais floues/ambiguës" }
                },
                "context_additions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": { "fact": { "type": "string" } },
                        "required": ["fact"]
                    },
                    "description": if en { "Durable facts learned about the user's world" } else { "Faits durables appris sur l'univers de l'utilisateur" }
                }
            },
            "required": ["transcription_fixes", "unassigned_tasks", "unclear_sentences", "context_additions"]
        }
    }])
}

/// One Claude call → `Clarifications` (timestamps not yet filled). Forces the
/// `submit_clarifications` tool so the response is always structured.
async fn call_analyze(text: &str, context: Option<&str>, recording_id: &str, db: &SqlitePool) -> Result<Clarifications> {
    if text.trim().is_empty() {
        return Ok(Clarifications::default());
    }
    let access = resolve_access(db).await?;
    let client = reqwest::Client::new();
    // Aucune consigne de langue n'existait ici (contrairement à l'ingestion/au
    // contexte) — l'analyse dérivait donc vers le français via le seul system
    // prompt + schéma français (spec/05/17, 2e test tranché).
    let lang = recording_language(db, Some(recording_id)).await;
    let system_text = format!("{}\n{}", ANALYZE_SYSTEM, language_directive(lang));
    let body = json!({
        "model": MODEL,
        "max_tokens": 2048,
        "thinking": {"type": "disabled"},
        "system": system_blocks(&system_text, context),
        "tools": analyze_tool(lang),
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
    let mut clar = call_analyze(&text, context.as_deref(), recording_id, db).await?;
    let segments = fetch_segments(recording_id, db).await.unwrap_or_default();
    fill_timestamps(&mut clar, &segments);
    Ok(clar)
}

/// Finalization pass (spec/17 §3): write the compte-rendu from the CORRECTED text
/// (+ the user's answers already folded into it), then auto-write any accepted
/// learned facts to `## Appris automatiquement` and regenerate the glossary.
/// **The only path that ever writes the compte-rendu/tâches** — always triggered
/// by the user's "Valider" on `/resolve` (spec/17 §3, feedback tests: no more
/// auto-chaining when there was nothing to fix).
pub async fn finalize_ingestion(
    recording_id: &str,
    corrected_text: &str,
    note_title: &str,
    context_additions: Vec<String>,
    summary: bool,
    tasks: bool,
    db: &SqlitePool,
    vault_root: Option<&Path>,
    app_handle: &tauri::AppHandle,
) -> Result<()> {
    run_ingestion_core(corrected_text, note_title, Some(recording_id), summary, tasks, db, vault_root, app_handle).await?;

    // La vérification en attente, s'il y en avait une, est résolue (spec/17
    // §3/spec/07) — l'indicateur « à vérifier » disparaît de la note.
    if let Err(e) = pending_clarifications::delete(db, recording_id).await {
        eprintln!("[ingestion] failed to clear pending clarification for {}: {}", recording_id, e);
    }
    let _ = app_handle.emit("pending-clarifications-changed", json!({}));

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
- Enrobe la liste dans une courte phrase, DANS LA LANGUE PRINCIPALE DU CONTEXTE (repli donné ci-dessous si indéterminable) — n'écris PAS systématiquement en français, la langue de la phrase doit suivre celle du contexte. Exemples de forme, à adapter à la langue réelle (ne recopie pas l'exemple FR par défaut) : FR « Transcription en français. Termes et noms propres : <liste séparée par des virgules>. » ; EN « Transcription in English. Terms and proper nouns: <comma-separated list>. »
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
    let system_text = format!("{}\n{}", GLOSSARY_SYSTEM, language_instruction(db).await);
    let body = json!({
        "model": MODEL,
        "max_tokens": 1024,
        "thinking": {"type": "disabled"},
        "system": [{
            "type": "text",
            "text": system_text,
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
- Reste fidèle : n'invente pas d'information non dite. Rédige dans la même langue que la présentation orale (voir consigne de langue ci-dessous si besoin d'un repli). Orthographie au mieux les noms propres (au besoin d'après le son)."#;

fn context_build_tool(lang: &str) -> serde_json::Value {
    let en = lang == "en";
    json!([{
        "name": "submit_context",
        "description": if en { "Structure the spoken introduction into the user's context sheet." } else { "Structure la présentation orale dans la fiche de contexte de l'utilisateur." },
        "input_schema": {
            "type": "object",
            "properties": {
                "entreprise": { "type": "string", "description": if en { "Who the user is, their role, their company and what it does" } else { "Qui est l'utilisateur, son rôle, son entreprise et ce qu'elle fait" } },
                "equipe": { "type": "string", "description": if en { "Colleagues mentioned (first name + role), bullet list" } else { "Collègues cités (prénom + rôle), en liste à puces" } },
                "vocabulaire": { "type": "string", "description": if en { "Proper nouns, clients, acronyms, tools and jargon mentioned, bullet list" } else { "Noms propres, clients, sigles, outils et jargon cités, en liste à puces" } },
                "projets": { "type": "string", "description": if en { "Current projects mentioned (name + one line), bullet list" } else { "Projets en cours cités (nom + une ligne), en liste à puces" } }
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
    note_title: Option<&str>,
    db: &SqlitePool,
    vault_root: Option<&Path>,
    app_handle: &tauri::AppHandle,
) -> Result<()> {
    // `note_title` (the raw-transcription note name) lets the correction screen
    // re-listen to the WAV via `read_recording_wav` (spec/13 étape 5).
    let emit_status = |status: &str, sections: usize, terms: usize, message: Option<String>| {
        let _ = app_handle.emit(
            "context-status-changed",
            json!({
                "status": status,
                "recording_id": recording_id,
                "note_title": note_title,
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

    match build_context_inner(transcription_text, recording_id, db, vault_root).await {
        Ok((sections, terms)) => {
            // Archivage de la transcription brute de CONTEXTE (spec/07/13,
            // feedback tests) : ce chemin ne passe jamais par
            // `run_ingestion_core` (pas de compte-rendu en mode contexte),
            // donc la note restait seule visible dans Notes alors que toutes
            // les autres transcriptions disparaissent après ingestion.
            // `Contexte Alfred.md` elle-même reste évidemment `active`.
            let recording_folder = crate::transcription::recording_folder(db).await;
            crate::notes::vault::archive_raw_note_by_recording_id(vault_root, &recording_folder, recording_id).await;
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
    recording_id: &str,
    db: &SqlitePool,
    vault_root: &Path,
) -> Result<(usize, usize)> {
    if transcription_text.trim().is_empty() {
        return Err(anyhow!("Transcription vide — rien à structurer"));
    }

    let access = resolve_access(db).await?;
    let client = reqwest::Client::new();
    // Langue du CONTENU des champs (spec/05/17, 2e test tranché) — dérivée de la
    // langue détectée pour cet enregistrement, pas inférée. Distinct des titres
    // de section de la note (`titles(app_language)` ci-dessous), qui suivent
    // délibérément la langue UI (spec/16).
    let lang = recording_language(db, Some(recording_id)).await;
    let system_text = format!("{}\n{}", CONTEXT_BUILD_SYSTEM, language_directive(lang));
    let body = json!({
        "model": MODEL,
        "max_tokens": 2048,
        "thinking": {"type": "disabled"},
        "system": [{ "type": "text", "text": system_text, "cache_control": {"type": "ephemeral"} }],
        "tools": context_build_tool(lang),
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
    // (spec/16) so glossary derivation and manual editing stay consistent —
    // localisés selon `app_language` (spec/16/21), pas codés en dur en français.
    let titles = crate::notes::context::titles(&app_language(db).await);
    let section = |title: &str, content: &str| {
        let c = content.trim();
        format!("## {}\n\n{}\n", title, c)
    };
    let body = format!(
        "# {}\n\n{}\n{}\n{}\n{}",
        titles.doc_title,
        section(titles.company, &sections.entreprise),
        section(titles.team, &sections.equipe),
        section(titles.vocab, &sections.vocabulaire),
        section(titles.projects, &sections.projets),
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

    // Ce texte est le CONTENU envoyé à Claude, et `language_instruction` lui dit
    // d'écrire dans la langue du contenu fourni — un repli codé en dur en
    // français faisait donc lire du français à Claude même quand il n'y avait
    // ni tâche ni note (bug constaté : brief FR sur une app/config EN, aucune
    // vraie tâche/note pour indiquer une langue). Localisé selon `app_language`
    // (spec/05/21) pour rester cohérent dans ce cas-là.
    let en = app_language(db).await == "en";
    let due_label = if en { " (due {})" } else { " (échéance {})" };

    let todos = crate::todos::get_todos(db, vault_root).await.unwrap_or_default();
    let todos_text = if todos.is_empty() {
        if en { "No tasks pending.".to_string() } else { "Aucune tâche en attente.".to_string() }
    } else {
        todos
            .iter()
            .take(15)
            .map(|t| {
                format!(
                    "- {}{}",
                    t.title,
                    t.echeance.as_deref().map(|d| due_label.replace("{}", d)).unwrap_or_default()
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
                if en { "No recent notes.".to_string() } else { "Aucune note récente.".to_string() }
            } else {
                recents.iter().map(|r| format!("- {}", r.title)).collect::<Vec<_>>().join("\n")
            }
        }
        None => if en { "Vault not configured.".to_string() } else { "Vault non configuré.".to_string() },
    };

    let (tasks_heading, notes_heading) = if en { ("Current tasks", "Recent notes") } else { ("Tâches en cours", "Notes récentes") };
    let prompt = format!("## {}\n{}\n\n## {}\n{}", tasks_heading, todos_text, notes_heading, recents_text);

    let client = reqwest::Client::new();
    // Contrairement à l'ingestion/au chat (une SEULE source — transcription ou
    // question — dont la langue se détecte bien), le brief agrège des titres de
    // plusieurs tâches/notes qui peuvent chacun être dans une langue différente :
    // il n'y a pas de « langue du contenu » unique à suivre. `language_instruction`
    // (repli seulement si ambigu) laissait Claude suivre la langue dominante des
    // titres plutôt que `app_language` — brief resté en français malgré une note
    // ajoutée en anglais (bug constaté, feedback tests). Consigne inconditionnelle.
    let brief_language = if en { "anglais (English)" } else { "français" };
    let system_text = format!("{}\n- Langue de la réponse : réponds TOUJOURS en {}, quelle que soit la langue des titres de tâches/notes ci-dessous.", DAILY_BRIEF_SYSTEM, brief_language);
    let body = json!({
        "model": MODEL,
        "max_tokens": 400,
        "thinking": {"type": "disabled"},
        "system": [{
            "type": "text",
            "text": system_text,
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
}
