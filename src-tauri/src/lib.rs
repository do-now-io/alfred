pub mod ai;
pub mod audio;
pub mod db;
pub mod feedback;
pub mod keychain;
pub mod metrics;
pub mod notes;
pub mod sharing;
pub mod state;
pub mod subscription;
pub mod todos;
pub mod transcription;

use std::sync::{Arc, Mutex as StdMutex};
use tauri::{Emitter, Manager};
use tokio::sync::{mpsc, Mutex};

use state::AppState;

// ─── Recording commands ────────────────────────────────────────────────────────

#[tauri::command]
async fn start_recording(
    source: String,
    purpose: Option<String>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let active_id = state.active_recording_id.clone();

    audio::start_recording(
        &source,
        data_dir,
        state.db.clone(),
        app,
        state.recording_handle.clone(),
        active_id,
        state.recording_stop_flag.clone(),
        state.transcription_tx.clone(),
    )
    .await
    .map_err(|e| e.to_string())?;

    // Mark the recording's purpose (spec/13). The row was just inserted with the
    // default 'meeting'; only the context recording of the guided tour overrides
    // it. Dynamic query — `purpose` (migration 010) needn't be in the dev DB.
    if purpose.as_deref() == Some("context") {
        let id = state.active_recording_id.lock().unwrap().clone();
        if let Some(id) = id {
            let _ = sqlx::query("UPDATE recordings SET purpose = 'context' WHERE id = ?")
                .bind(id)
                .execute(&state.db)
                .await;
        }
    }
    Ok(())
}

#[tauri::command]
async fn stop_recording(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let vault_path = state.vault_path.lock().unwrap().clone();
    let recording_id = audio::stop_recording(
        &data_dir,
        state.resource_dir.clone(),
        vault_path,
        state.active_recording_id.clone(),
        state.recording_stop_flag.clone(),
        state.recording_handle.clone(),
        state.db.clone(),
        state.transcription_tx.clone(),
        app,
    )
    .await
    .map_err(|e| e.to_string())?;

    let source: Option<String> = sqlx::query_scalar("SELECT source FROM recordings WHERE id = ?")
        .bind(&recording_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    metrics::send(
        "recording_completed",
        serde_json::json!({ "source": source.unwrap_or_else(|| "mic_only".into()) }),
    );

    Ok(recording_id)
}

#[tauri::command]
async fn test_microphone() -> Result<(), String> {
    audio::test_microphone().await.map_err(|e| e.to_string())
}

/// Import an existing WAV file and transcribe it through the same pipeline as a
/// live recording (spec/03 "Import de fichier audio"). Opens a native file picker
/// (`.wav`), copies the chosen file into `$APP_DATA_DIR/recordings/{id}.wav`,
/// records a `source='import'` row, and queues transcription. Returns the new
/// recording id, or `None` if the user cancels the picker.
#[tauri::command]
async fn import_audio_file(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .add_filter("Audio WAV", &["wav"])
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let src_path = picked.into_path().map_err(|e| e.to_string())?;

    // Reject anything hound can't open as a WAV *before* touching the queue, so
    // the user gets a clear error rather than a silent failure in the worker.
    {
        let src = src_path.clone();
        tokio::task::spawn_blocking(move || hound::WavReader::open(&src).map(|_| ()))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|_| "Fichier WAV illisible ou invalide. Convertissez-le d'abord (ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 out.wav).".to_string())?;
    }

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let recording_id = uuid::Uuid::new_v4().to_string();
    let dest = data_dir.join("recordings").join(format!("{}.wav", recording_id));
    tokio::fs::create_dir_all(dest.parent().unwrap())
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::copy(&src_path, &dest)
        .await
        .map_err(|e| format!("Copie du fichier échouée: {}", e))?;

    let now = chrono::Utc::now().to_rfc3339();
    let dest_str = dest.to_string_lossy().to_string();
    sqlx::query!(
        "INSERT INTO recordings (id, file_path, recorded_at, source, status) VALUES (?, ?, ?, 'import', 'processing')",
        recording_id, dest_str, now
    )
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    let vault_path = state.vault_path.lock().unwrap().clone();
    transcription::enqueue_job(
        recording_id.clone(),
        dest,
        state.db.clone(),
        app.clone(),
        data_dir,
        state.resource_dir.clone(),
        vault_path,
        &state.transcription_tx,
    )
    .await
    .map_err(|e| e.to_string())?;

    // Reuse the live-recording status channel so the butler label shows
    // "transcription en cours" without any import-specific frontend wiring.
    let _ = app.emit(
        "recording-status-changed",
        serde_json::json!({ "status": "processing", "duration_seconds": 0 }),
    );
    metrics::send("recording_completed", serde_json::json!({ "source": "import" }));

    Ok(Some(recording_id))
}

// ─── Transcription commands ───────────────────────────────────────────────────

#[tauri::command]
async fn download_model(
    size: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    transcription::download_model(&size, &data_dir, &app)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_transcription(
    recording_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<serde_json::Value>, String> {
    transcription::get_transcription(&recording_id, &state.db)
        .await
        .map_err(|e| e.to_string())
}

// ─── AI commands ───────────────────────────────────────────────────────────────

#[tauri::command]
async fn test_api_key(
    service: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    ai::test_api_key(&service, &state.http_client)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn generate_daily_brief(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    ai::generate_daily_brief(&state.db, vault_root.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_daily_brief(
    state: tauri::State<'_, AppState>,
) -> Result<Option<serde_json::Value>, String> {
    ai::get_daily_brief(&state.db)
        .await
        .map(|opt| opt.map(|(text, generated_at)| serde_json::json!({ "text": text, "generated_at": generated_at })))
        .map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
struct FeedbackImageInput {
    filename: Option<String>,
    content_type: Option<String>,
    data: String,
}

#[tauri::command]
async fn submit_feedback(
    category: String,
    text: String,
    contact_email: Option<String>,
    view: Option<String>,
    images: Vec<FeedbackImageInput>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let images = images
        .into_iter()
        .map(|i| feedback::FeedbackImage {
            filename: i.filename,
            content_type: i.content_type,
            data: i.data,
        })
        .collect();

    feedback::submit_feedback(
        &category,
        &text,
        contact_email.as_deref(),
        view.as_deref(),
        images,
        &app.package_info().version.to_string(),
        &state.db,
        &state.http_client,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn subscribe_alfredia(
    plan: Option<String>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    subscription::subscribe(plan.as_deref().unwrap_or("monthly"), &state.db, &app)
        .await
        .map_err(|e| e.to_string())
}

/// Answers a question over the vault AND records the exchange in the chat
/// history (spec/10) — creating a new conversation when `conversation_id` is
/// absent. Persistence is best-effort: a history write failure never loses the
/// answer the user is waiting on.
#[tauri::command]
async fn ask_notes(
    question: String,
    history: Vec<ai::chat::ChatMessage>,
    conversation_id: Option<String>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ai::chat_history::ChatExchangeResult, String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    let response = ai::chat::answer_question(question.clone(), history, vault_root, &state.db, &app)
        .await
        .map_err(|e| e.to_string())?;

    let conv_id = match ai::chat_history::record_exchange(
        &state.db,
        conversation_id.as_deref(),
        &question,
        &response.answer,
        &response.sources,
    )
    .await
    {
        Ok(id) => id,
        Err(e) => {
            eprintln!("[chat] failed to record exchange: {}", e);
            conversation_id.unwrap_or_default()
        }
    };

    Ok(ai::chat_history::ChatExchangeResult {
        answer: response.answer,
        sources: response.sources,
        conversation_id: conv_id,
    })
}

#[tauri::command]
async fn list_chat_conversations(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ai::chat_history::ChatConversation>, String> {
    ai::chat_history::list_conversations(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_chat_messages(
    conversation_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ai::chat_history::StoredChatMessage>, String> {
    ai::chat_history::get_messages(&state.db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_chat_conversation(
    conversation_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    ai::chat_history::delete_conversation(&state.db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

// ─── Todo commands (file-based — Todo.md is the source of truth, spec/06) ──────

#[tauri::command]
async fn get_todos(state: tauri::State<'_, AppState>) -> Result<Vec<todos::Todo>, String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    todos::get_todos(&state.db, vault_root.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_todo(
    input: todos::CreateTodoInput,
    state: tauri::State<'_, AppState>,
) -> Result<todos::Todo, String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    todos::create_todo(&input, &state.db, vault_root.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Toggle done — checks/unchecks the line in place (spec/06).
#[tauri::command]
async fn complete_todo(
    id: String,
    checked: Option<bool>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    todos::set_todo_checked(&id, checked.unwrap_or(true), &state.db, vault_root.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Archive (ex-« ignorer ») — moves the task to `## Archivé`, never deletes.
#[tauri::command]
async fn dismiss_todo(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    todos::archive_todo(&id, &state.db, vault_root.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_todo(
    id: String,
    input: todos::CreateTodoInput,
    state: tauri::State<'_, AppState>,
) -> Result<todos::Todo, String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    todos::update_todo(&id, &input, &state.db, vault_root.as_deref())
        .await
        .map_err(|e| e.to_string())
}

// ─── Notes (vault) commands ───────────────────────────────────────────────────

fn get_vault_root(state: &tauri::State<'_, AppState>) -> Result<std::path::PathBuf, String> {
    state
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Vault not configured. Set it in Settings → Notes.".to_string())
}

#[tauri::command]
async fn get_vault_tree(
    state: tauri::State<'_, AppState>,
) -> Result<notes::VaultNode, String> {
    let root = get_vault_root(&state)?;
    notes::vault::get_vault_tree(&root).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_note_file(
    path: String,
    _state: tauri::State<'_, AppState>,
) -> Result<notes::NoteFile, String> {
    notes::vault::get_note_file(std::path::Path::new(&path))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_note_file(
    folder: String,
    title: String,
    _state: tauri::State<'_, AppState>,
) -> Result<notes::NoteFile, String> {
    notes::vault::create_note_file(std::path::Path::new(&folder), &title)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_note_file(
    path: String,
    metadata: notes::NoteMetadata,
    body: String,
    state: tauri::State<'_, AppState>,
) -> Result<notes::NoteFile, String> {
    let saved = notes::vault::update_note_file(std::path::Path::new(&path), metadata, &body)
        .await
        .map_err(|e| e.to_string())?;

    // Editing the context note (spec/16) → regenerate the Whisper glossary,
    // debounced (spec/17 §4). No manual "Régénérer" needed. Matched by filename
    // so it works regardless of the vault-relative folder.
    let vault_root = state.vault_path.lock().unwrap().clone();
    if let Some(root) = vault_root {
        let ctx_rel = notes::context::context_note_path(&state.db).await;
        let ctx_name = std::path::Path::new(&ctx_rel).file_name();
        let saved_name = std::path::Path::new(&path).file_name();
        if ctx_name.is_some() && saved_name == ctx_name {
            ai::schedule_glossary_regen(state.db.clone(), root);
        }
    }

    Ok(saved)
}

#[tauri::command]
async fn delete_note_file(
    path: String,
    _state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    notes::vault::delete_note_file(std::path::Path::new(&path))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_note_file(
    old_path: String,
    new_name: String,
    _state: tauri::State<'_, AppState>,
) -> Result<notes::NoteFile, String> {
    notes::vault::rename_note_file(std::path::Path::new(&old_path), &new_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_recent_notes(
    limit: Option<usize>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<notes::RecentNote>, String> {
    let root = get_vault_root(&state)?;
    let limit = limit.unwrap_or(5);
    tokio::task::spawn_blocking(move || notes::vault::list_recent_notes(&root, limit))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Every note with its `project` frontmatter, for the "group by project" view
/// (spec/07). Grouping is virtual — no file is moved.
#[tauri::command]
async fn get_notes_by_project(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<notes::vault::ProjectNote>, String> {
    let root = get_vault_root(&state)?;
    tokio::task::spawn_blocking(move || notes::vault::list_notes_with_project(&root))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_vault_graph(
    state: tauri::State<'_, AppState>,
) -> Result<notes::graph::VaultGraph, String> {
    let root = get_vault_root(&state)?;
    tokio::task::spawn_blocking(move || notes::graph::build_graph(&root))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Opens (creating it with its template if needed) the contexte interne note
/// (spec/16) — `Contexte Alfred.md` at the vault root by default.
#[tauri::command]
async fn open_context_note(
    state: tauri::State<'_, AppState>,
) -> Result<notes::NoteFile, String> {
    let root = get_vault_root(&state)?;
    let path = notes::context::ensure_context_note(&root, &state.db)
        .await
        .map_err(|e| e.to_string())?;
    notes::vault::get_note_file(&path)
        .await
        .map_err(|e| e.to_string())
}

/// Derive the Whisper glossary from `Contexte Alfred.md` (spec/17 §1) and store
/// it in `config.transcription_glossary`. Called at onboarding, on context-note
/// change (debounced by the caller), or via a manual button. Returns the glossary.
#[tauri::command]
async fn generate_glossary_from_context(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    ai::generate_glossary_from_context(&state.db, vault_root.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Augmented ingestion — analysis pass (spec/17 §3): grouped propositions for a
/// recording's transcription, for the resolution screen.
#[tauri::command]
async fn analyze_transcription(
    recording_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<ai::Clarifications, String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    ai::analyze_transcription(&recording_id, &state.db, vault_root.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Augmented ingestion — finalization pass (spec/17 §3): write the compte-rendu
/// from the corrected text + fold accepted learned facts into the context.
#[tauri::command]
async fn finalize_ingestion(
    recording_id: String,
    corrected_text: String,
    note_title: String,
    context_additions: Vec<String>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    ai::finalize_ingestion(
        &recording_id,
        &corrected_text,
        &note_title,
        context_additions,
        &state.db,
        vault_root.as_deref(),
        &app,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Build `Contexte Alfred.md` from a recording's transcription (spec/13). Used by
/// the guided-tour "context" recording (auto-triggered) and reusable by a future
/// "(re)créer mon contexte à la voix" button. Emits `context-status-changed`.
#[tauri::command]
async fn build_context_from_transcription(
    recording_id: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    let text: Option<String> =
        sqlx::query_scalar("SELECT raw_text FROM transcriptions WHERE recording_id = ?")
            .bind(&recording_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    let text = text.ok_or_else(|| "Aucune transcription pour cet enregistrement".to_string())?;
    ai::build_context_from_transcription(&recording_id, &text, &state.db, vault_root.as_deref(), &app)
        .await
        .map_err(|e| e.to_string())
}

// ─── Note sharing (spec/18) ──────────────────────────────────────────────────

/// Share a note: upload its Markdown (frontmatter stripped — internal metadata
/// like `recording_id` never leaves the vault) and return the public URL. Idempotent
/// per note: re-sharing updates the same URL.
#[tauri::command]
async fn share_note(
    note_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let raw = tokio::fs::read_to_string(&note_path)
        .await
        .map_err(|e| format!("Lecture de la note: {}", e))?;
    let stem = std::path::Path::new(&note_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let (metadata, body) = notes::frontmatter::parse(&raw, &stem);
    sharing::upload_share(&state.db, &state.http_client, &note_path, &metadata.title, &body)
        .await
        .map_err(|e| e.to_string())
}

/// Absolute path of the aggregated task list (`Todo.md`) — the local share key.
async fn todos_key(state: &tauri::State<'_, AppState>) -> Result<(std::path::PathBuf, String), String> {
    let vault_root = state
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Vault non configuré".to_string())?;
    let rel = todos::todo_file_path(&state.db).await;
    let path = vault_root.join(&rel);
    let key = path.to_string_lossy().to_string();
    Ok((path, key))
}

/// Share the aggregated task list (`Todo.md`).
#[tauri::command]
async fn share_todos(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let (path, key) = todos_key(&state).await?;
    let markdown = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Lecture des tâches: {}", e))?;
    sharing::upload_share(&state.db, &state.http_client, &key, "Tâches", &markdown)
        .await
        .map_err(|e| e.to_string())
}

/// Public URL of the shared task list, if any.
#[tauri::command]
async fn get_todos_share_link(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    let (_, key) = todos_key(&state).await?;
    Ok(sharing::share_link(&state.db, &key).await)
}

/// Stop sharing the task list.
#[tauri::command]
async fn unshare_todos(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let (_, key) = todos_key(&state).await?;
    sharing::remove_share(&state.db, &state.http_client, &key)
        .await
        .map_err(|e| e.to_string())
}

/// Stop sharing a note (revoke the public link).
#[tauri::command]
async fn unshare_note(
    note_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    sharing::remove_share(&state.db, &state.http_client, &note_path)
        .await
        .map_err(|e| e.to_string())
}

/// The public URL if this note (or Todo.md path) is currently shared, else null.
#[tauri::command]
async fn get_share_link(
    note_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    Ok(sharing::share_link(&state.db, &note_path).await)
}

/// Raw WAV bytes for a recording (by its note title), for the "🔊 réécouter"
/// button of the resolution screen (spec/17 §3). Returns an ArrayBuffer to the
/// front (efficient — no base64/JSON-array bloat); the UI seeks to the segment.
#[tauri::command]
async fn read_recording_wav(
    note_title: String,
    state: tauri::State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    let vault_root = state
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Vault non configuré".to_string())?;
    let folder = transcription::recording_folder(&state.db).await;
    let path = vault_root.join(folder).join(format!("{}.wav", note_title));
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Audio introuvable ({:?}): {}", path, e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn get_vault_path(
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    Ok(state
        .vault_path
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| p.to_string_lossy().to_string()))
}

/// Sets the vault path and scaffolds its expected structure (spec/13):
/// `alfred-raw/`, `alfred-intelligence/`, and a skeleton `Todo.md` — idempotent,
/// never touches existing files/folders.
#[tauri::command]
async fn set_vault_path(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let pb = std::path::PathBuf::from(&path);
    *state.vault_path.lock().unwrap() = Some(pb.clone());
    sqlx::query!(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('notes_vault_path', ?)",
        path
    )
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    let recording_folder = transcription::recording_folder(&state.db).await;
    let intelligence_folder = ai::intelligence_folder(&state.db).await;
    let todo_rel_path = todos::todo_file_path(&state.db).await;
    notes::vault::scaffold_vault(&pb, &recording_folder, &intelligence_folder, &todo_rel_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_vault_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .blocking_pick_folder();
    Ok(path.map(|p| p.to_string()))
}

// ─── Config & Keychain commands ───────────────────────────────────────────────

#[tauri::command]
async fn get_todo_file(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    Ok(todos::todo_file_path(&state.db).await)
}

/// Vault-relative folder where recordings (audio + transcription note) are saved.
#[tauri::command]
async fn get_recording_folder(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    Ok(transcription::recording_folder(&state.db).await)
}

/// Manual "ré-ingérer" (spec/05): relaunches the merged ingestion on a specific
/// `alfred-raw/` note. The automatic trigger (after `transcription-complete`)
/// calls `ai::run_ingestion_for_recording` directly — see transcription/mod.rs.
#[tauri::command]
async fn run_ingest(
    note_path: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    ai::run_ingestion_for_note(std::path::Path::new(&note_path), &state.db, vault_root.as_deref(), &app)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_config(
    key: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    sqlx::query_scalar!("SELECT value FROM config WHERE key = ?", key)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_config(
    key: String,
    value: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    sqlx::query!(
        "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
        key,
        value
    )
    .execute(&state.db)
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_secret(account: String) -> Result<Option<String>, String> {
    keychain::get_secret(&account).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_secret(account: String, value: String) -> Result<(), String> {
    keychain::save_secret(&account, &value).map_err(|e| e.to_string())
}

// ─── System commands ──────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
#[tauri::command]
fn get_launch_at_login() -> Result<bool, String> {
    let plist_path = dirs::home_dir()
        .map(|h| h.join("Library/LaunchAgents/io.alfred.app.plist"))
        .ok_or("Cannot determine home dir")?;
    Ok(plist_path.exists())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn set_launch_at_login(enabled: bool) -> Result<(), String> {
    let plist_path = dirs::home_dir()
        .map(|h| h.join("Library/LaunchAgents/io.alfred.app.plist"))
        .ok_or("Cannot determine home dir")?;

    if enabled {
        let plist = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
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
</plist>"#;

        if let Some(parent) = plist_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&plist_path, plist).map_err(|e| e.to_string())?;
        std::process::Command::new("launchctl")
            .args(["load", plist_path.to_str().unwrap_or("")])
            .output()
            .map_err(|e| e.to_string())?;
    } else {
        if plist_path.exists() {
            std::process::Command::new("launchctl")
                .args(["unload", plist_path.to_str().unwrap_or("")])
                .output()
                .map_err(|e| e.to_string())?;
            std::fs::remove_file(&plist_path).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

/// Windows: launch-at-login is backed by the per-user Run registry key
/// `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (value name "Alfred").
/// We shell out to `reg.exe` so no extra crate dependency is needed.
#[cfg(target_os = "windows")]
const WIN_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_launch_at_login() -> Result<bool, String> {
    let output = std::process::Command::new("reg")
        .args(["query", WIN_RUN_KEY, "/v", "Alfred"])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(output.status.success())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn set_launch_at_login(enabled: bool) -> Result<(), String> {
    if enabled {
        let exe = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        let status = std::process::Command::new("reg")
            .args([
                "add", WIN_RUN_KEY, "/v", "Alfred", "/t", "REG_SZ", "/d", &exe, "/f",
            ])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Failed to write Run registry key".to_string());
        }
    } else {
        // Deleting a value that doesn't exist returns a non-zero status — treat
        // "already absent" as success by checking first.
        if get_launch_at_login()? {
            let status = std::process::Command::new("reg")
                .args(["delete", WIN_RUN_KEY, "/v", "Alfred", "/f"])
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("Failed to remove Run registry key".to_string());
            }
        }
    }
    Ok(())
}

/// Other platforms: launch-at-login is not implemented — no-op so the Settings
/// toggle degrades gracefully instead of erroring.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
fn get_launch_at_login() -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
fn set_launch_at_login(_enabled: bool) -> Result<(), String> {
    Ok(())
}

// ─── App builder ──────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            let data_dir = app.path().app_data_dir().expect("Cannot get app data dir");
            std::fs::create_dir_all(&data_dir).expect("Cannot create app data dir");

            keychain::init(data_dir.clone());

            let db_path = data_dir.join("alfred.db");

            let (transcription_tx, transcription_rx) = mpsc::channel::<transcription::TranscriptionJob>(32);

            let db = tauri::async_runtime::block_on(db::init_pool(&db_path))
                .expect("Cannot init database");

            let resource_dir = app.path().resource_dir().ok();

            // Load vault path from config
            let vault_path = tauri::async_runtime::block_on(async {
                sqlx::query_scalar!("SELECT value FROM config WHERE key = 'notes_vault_path'")
                    .fetch_optional(&db)
                    .await
                    .ok()
                    .flatten()
                    .filter(|v: &String| !v.is_empty())
                    .map(std::path::PathBuf::from)
            });
            eprintln!("[setup] vault_path = {:?}", vault_path);

            let http_client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("Cannot build HTTP client");

            let state = AppState {
                db: db.clone(),
                recording_handle: Arc::new(Mutex::new(None)),
                active_recording_id: Arc::new(StdMutex::new(None)),
                recording_stop_flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                transcription_tx,
                http_client: http_client.clone(),
                resource_dir,
                vault_path: Arc::new(StdMutex::new(vault_path.clone())),
            };

            app.manage(state);

            // Anonymous usage metrics (spec/15): install_id + install_created/app_launched.
            {
                let db_metrics = db.clone();
                let app_version = app.package_info().version.to_string();
                tauri::async_runtime::spawn(async move {
                    metrics::init(&db_metrics, http_client, &app_version).await;
                });
            }

            // Migrate old SQLite notes to vault (if vault configured)
            if let Some(ref vp) = vault_path {
                let db_migrate = db.clone();
                let vault_root = vp.clone();
                tauri::async_runtime::spawn(async move {
                    match notes::vault::migrate_sqlite_to_vault(&db_migrate, &vault_root).await {
                        Ok(n) if n > 0 => eprintln!("[notes] migrated {} notes to vault", n),
                        Err(e) => eprintln!("[notes] migration warning: {}", e),
                        _ => {}
                    }
                });
            }

            // Start transcription worker
            tauri::async_runtime::spawn(transcription::run_transcription_worker(transcription_rx));

            let _ = app_handle; // kept for future setup steps

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Recording
            start_recording,
            stop_recording,
            test_microphone,
            import_audio_file,
            // Transcription
            download_model,
            get_transcription,
            // AI
            test_api_key,
            ask_notes,
            list_chat_conversations,
            get_chat_messages,
            delete_chat_conversation,
            generate_daily_brief,
            get_daily_brief,
            submit_feedback,
            subscribe_alfredia,
            // Todos
            get_todos,
            create_todo,
            complete_todo,
            dismiss_todo,
            update_todo,
            // Notes (vault)
            get_vault_tree,
            get_note_file,
            create_note_file,
            update_note_file,
            delete_note_file,
            rename_note_file,
            get_recent_notes,
            get_notes_by_project,
            get_vault_graph,
            get_vault_path,
            set_vault_path,
            pick_vault_folder,
            open_context_note,
            generate_glossary_from_context,
            analyze_transcription,
            finalize_ingestion,
            build_context_from_transcription,
            read_recording_wav,
            share_note,
            share_todos,
            unshare_note,
            get_share_link,
            get_todos_share_link,
            unshare_todos,
            // Config & Keychain
            get_config,
            set_config,
            run_ingest,
            get_todo_file,
            get_recording_folder,
            get_secret,
            save_secret,
            // System
            get_launch_at_login,
            set_launch_at_login,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
