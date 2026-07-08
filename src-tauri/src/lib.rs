pub mod ai;
pub mod audio;
pub mod auth;
pub mod calendar;
pub mod db;
pub mod feedback;
pub mod keychain;
pub mod metrics;
pub mod notes;
pub mod phone_calls;
pub mod state;
pub mod subscription;
pub mod suggestions;
pub mod todos;
pub mod transcription;

use std::sync::{Arc, Mutex as StdMutex};
use tauri::{Emitter, Manager};
use tokio::sync::{mpsc, Mutex};

use state::AppState;

// ─── Calendar commands ────────────────────────────────────────────────────────

#[tauri::command]
async fn get_today_events(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<calendar::CalendarEvent>, String> {
    calendar::get_today_events(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_week_events(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<calendar::CalendarEvent>, String> {
    calendar::get_week_events(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn trigger_calendar_sync(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let google_count = calendar::sync_google_calendar(&state.db, &state.http_client)
        .await
        .unwrap_or(0);

    app.emit(
        "calendar-synced",
        serde_json::json!({
            "event_count": google_count,
            "synced_at": chrono::Utc::now().to_rfc3339()
        }),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn get_account_status() -> Result<auth::AccountStatus, String> {
    Ok(auth::get_account_status())
}

#[tauri::command]
async fn disconnect_account() -> Result<(), String> {
    auth::disconnect_account().map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_google_oauth(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    auth::start_google_oauth(app, state.oauth_port.clone(), state.http_client.clone())
        .await
        .map_err(|e| e.to_string())
}

// ─── Recording commands ────────────────────────────────────────────────────────

#[tauri::command]
async fn start_recording(
    source: String,
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
    .map_err(|e| e.to_string())
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

// ─── Transcription commands ───────────────────────────────────────────────────

#[tauri::command]
async fn download_model(
    size: String,
    state: tauri::State<'_, AppState>,
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
async fn generate_event_briefing(
    event_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    ai::generate_event_briefing(&event_id, &state.db, vault_root)
        .await
        .map_err(|e| e.to_string())
}

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
    _state: tauri::State<'_, AppState>,
) -> Result<notes::NoteFile, String> {
    notes::vault::update_note_file(std::path::Path::new(&path), metadata, &body)
        .await
        .map_err(|e| e.to_string())
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

// ─── Suggestions commands ─────────────────────────────────────────────────────

#[tauri::command]
async fn get_suggestions(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<suggestions::Suggestion>, String> {
    suggestions::get_suggestions(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn accept_suggestion(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    suggestions::accept_suggestion(&id, &state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn dismiss_suggestion(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    suggestions::dismiss_suggestion(&id, &state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_booking_suggestion(
    event_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<suggestions::Suggestion, String> {
    suggestions::create_booking_suggestion(&event_id, &state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_suggestion_engine(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    suggestions::run_suggestion_engine(&state.db, &state.http_client, &app)
        .await
        .map_err(|e| e.to_string())
}

// ─── Phone call commands ──────────────────────────────────────────────────────

#[tauri::command]
async fn initiate_phone_call(
    suggestion_id: String,
    phone_number: String,
    party_size: i64,
    requested_time: String,
    restaurant_name: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<phone_calls::PhoneCall, String> {
    phone_calls::initiate_phone_call(
        &suggestion_id,
        &phone_number,
        party_size,
        &requested_time,
        restaurant_name.as_deref(),
        &state.db,
        &state.http_client,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_call_status(
    call_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<phone_calls::PhoneCall, String> {
    phone_calls::get_call_status(&call_id, &state.db, &state.http_client)
        .await
        .map_err(|e| e.to_string())
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
                oauth_port: Arc::new(Mutex::new(None)),
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

            // Start calendar sync loop
            let db_sync = db.clone();
            let http_client_sync = reqwest::Client::new();
            let app_sync = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                // Initial sync
                let _ = calendar::sync_google_calendar(&db_sync, &http_client_sync).await;
                let _ = app_sync.emit(
                    "calendar-synced",
                    serde_json::json!({ "event_count": 0, "synced_at": chrono::Utc::now().to_rfc3339() }),
                );

                // Periodic sync
                let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(15 * 60));
                loop {
                    interval.tick().await;
                    let _ = calendar::sync_google_calendar(&db_sync, &http_client_sync).await;
                    let _ = app_sync.emit(
                        "calendar-synced",
                        serde_json::json!({ "event_count": 0, "synced_at": chrono::Utc::now().to_rfc3339() }),
                    );
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Calendar
            get_today_events,
            get_week_events,
            trigger_calendar_sync,
            get_account_status,
            disconnect_account,
            start_google_oauth,
            // Recording
            start_recording,
            stop_recording,
            test_microphone,
            // Transcription
            download_model,
            get_transcription,
            // AI
            generate_event_briefing,
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
            get_vault_graph,
            get_vault_path,
            set_vault_path,
            pick_vault_folder,
            // Suggestions
            get_suggestions,
            create_booking_suggestion,
            accept_suggestion,
            dismiss_suggestion,
            run_suggestion_engine,
            // Phone calls
            initiate_phone_call,
            get_call_status,
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
