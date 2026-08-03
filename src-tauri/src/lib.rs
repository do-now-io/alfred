pub mod ai;
pub mod audio;
pub mod db;
pub mod email;
pub mod feedback;
pub mod keychain;
pub mod metrics;
pub mod notes;
pub mod seed;
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
    // La capture est un singleton (spec/07b) : pas d'enregistrement pendant une dictée.
    if *state.dictation_active.lock().unwrap() {
        return Err("Une dictée est en cours, terminez-la avant d'enregistrer.".to_string());
    }

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
        state.recording_pause_flag.clone(),
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

/// « Terminer » (spec/03, feedback tests — retour arrière sur le panneau de
/// sélection) : arrête la prise puis lance **automatiquement** transcription +
/// compte-rendu + tâches pour une **réunion** (`purpose: "meeting"`) — plus de
/// panneau de cases à cocher. La vérification `/resolve` reste le seul point de
/// contrôle (spec/17 §3). Pour le **contexte** (`purpose: "context"`, téléprompteur
/// de la visite guidée, spec/13) la prise reste en revue « prise terminée »
/// (Recommencer / Continuer, découplé — `process_recording` reste utilisé là).
#[tauri::command]
async fn stop_recording(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let recording_id = audio::stop_recording(
        &data_dir,
        state.active_recording_id.clone(),
        state.recording_stop_flag.clone(),
        state.recording_pause_flag.clone(),
        state.recording_handle.clone(),
        state.db.clone(),
        app.clone(),
    )
    .await
    .map_err(|e| {
        metrics::send("recording_failed", serde_json::json!({ "stage": "stop" }));
        e.to_string()
    })?;

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

    let purpose: Option<String> = sqlx::query_scalar("SELECT purpose FROM recordings WHERE id = ?")
        .bind(&recording_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    if purpose.as_deref().unwrap_or("meeting") == "meeting" {
        enqueue_processing(&recording_id, &data_dir, true, true, &state, &app)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(recording_id)
}

/// Enfile la transcription (+ ingestion, spec/05) d'une prise déjà arrêtée —
/// factorisé entre l'auto-lancement réunion (`stop_recording`) et le bouton
/// « Continuer » du panneau de revue contexte (`process_recording`).
async fn enqueue_processing(
    recording_id: &str,
    data_dir: &std::path::Path,
    summary: bool,
    tasks: bool,
    state: &tauri::State<'_, AppState>,
    app: &tauri::AppHandle,
) -> Result<(), anyhow::Error> {
    let file_path = data_dir.join("recordings").join(format!("{}.wav", recording_id));
    if !file_path.exists() {
        metrics::send("recording_failed", serde_json::json!({ "stage": "enqueue" }));
        return Err(anyhow::anyhow!("WAV introuvable pour cette prise: {:?}", file_path));
    }

    sqlx::query!("UPDATE recordings SET status = 'processing' WHERE id = ?", recording_id)
        .execute(&state.db)
        .await?;

    let vault_path = state.vault_path.lock().unwrap().clone();
    transcription::enqueue_job(
        recording_id.to_string(),
        file_path,
        state.db.clone(),
        app.clone(),
        data_dir.to_path_buf(),
        state.resource_dir.clone(),
        vault_path,
        summary,
        tasks,
        &state.transcription_tx,
    )
    .await?;

    let _ = app.emit(
        "recording-status-changed",
        serde_json::json!({ "status": "processing", "duration_seconds": 0, "recording_id": recording_id }),
    );
    Ok(())
}

/// Bouton « Annuler » pendant la prise (spec/03) : arrête + jette le WAV, aucun aval.
#[tauri::command]
async fn cancel_recording(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    audio::cancel_recording(
        &data_dir,
        state.active_recording_id.clone(),
        state.recording_stop_flag.clone(),
        state.recording_pause_flag.clone(),
        state.recording_handle.clone(),
        state.db.clone(),
        app,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Supprime une prise en revue « prise terminée » (bouton Supprimer / le
/// « Recommencer » du téléprompteur, spec/03/13) : WAV jeté + ligne DB supprimée.
#[tauri::command]
async fn discard_recording(
    recording_id: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    audio::discard_recording_files(&data_dir, &recording_id, &state.db)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(
        "recording-status-changed",
        serde_json::json!({ "status": "idle", "duration_seconds": 0 }),
    );
    Ok(())
}

/// Bouton « Continuer » du panneau de revue (spec/03) : lance seulement les
/// traitements cochés. `transcribe=false` → on ne garde que le WAV (déplacé dans
/// le vault) ; compte-rendu/tâches supposent la transcription (garde-fou côté UI,
/// re-vérifié ici).
#[tauri::command]
async fn process_recording(
    recording_id: String,
    transcribe: bool,
    summary: bool,
    tasks: bool,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file_path = data_dir.join("recordings").join(format!("{}.wav", recording_id));
    if !file_path.exists() {
        return Err(format!("WAV introuvable pour cette prise: {:?}", file_path));
    }

    if !transcribe {
        // Rien d'aval : on préserve juste l'audio dans le vault (spec/03 « ne
        // garder que le WAV ») et on clôt la prise.
        let vault_path = state.vault_path.lock().unwrap().clone();
        if let Some(vault_root) = vault_path {
            let folder = vault_root.join(transcription::recording_folder(&state.db).await);
            tokio::fs::create_dir_all(&folder).await.map_err(|e| e.to_string())?;
            let now = chrono::Local::now();
            let title = format!(
                "{}-{:02}-{:02} {:02}h{:02}",
                chrono::Datelike::year(&now),
                chrono::Datelike::month(&now),
                chrono::Datelike::day(&now),
                chrono::Timelike::hour(&now),
                chrono::Timelike::minute(&now)
            );
            let dest = folder.join(format!("{}.wav", title));
            if tokio::fs::rename(&file_path, &dest).await.is_err() {
                if tokio::fs::copy(&file_path, &dest).await.is_ok() {
                    let _ = tokio::fs::remove_file(&file_path).await;
                }
            }
        }
        sqlx::query!("UPDATE recordings SET status = 'done' WHERE id = ?", recording_id)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
        let _ = app.emit(
            "recording-status-changed",
            serde_json::json!({ "status": "idle", "duration_seconds": 0 }),
        );
        return Ok(());
    }

    enqueue_processing(&recording_id, &data_dir, summary, tasks, &state, &app)
        .await
        .map_err(|e| e.to_string())
}

/// Pause de la capture (spec/03/13) : les frames sont jetées, le chrono se fige,
/// la prise reste ouverte. L'état `paused` est émis par la boucle de capture.
#[tauri::command]
async fn pause_recording(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if state.active_recording_id.lock().unwrap().is_none() {
        return Err("Aucun enregistrement en cours".to_string());
    }
    state
        .recording_pause_flag
        .store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn resume_recording(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if state.active_recording_id.lock().unwrap().is_none() {
        return Err("Aucun enregistrement en cours".to_string());
    }
    state
        .recording_pause_flag
        .store(false, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn test_microphone() -> Result<(), String> {
    audio::test_microphone().await.map_err(|e| e.to_string())
}

// ─── Dictée éphémère (spec/07b) ────────────────────────────────────────────────
// Capture micro courte → Whisper (glossaire) → texte rendu à l'appelant. AUCUNE
// note, aucune ligne `recordings`, aucune ingestion : le WAV temporaire est
// supprimé après transcription. Exclusive de l'enregistrement de réunion.

fn dictation_wav_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("dictation.wav")
}

#[tauri::command]
async fn start_dictation(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if state.active_recording_id.lock().unwrap().is_some() {
        return Err("Un enregistrement est en cours, la dictée est indisponible.".to_string());
    }
    {
        let mut active = state.dictation_active.lock().unwrap();
        if *active {
            return Err("Une dictée est déjà en cours.".to_string());
        }
        *active = true;
    }

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let wav = dictation_wav_path(&data_dir);
    let _ = tokio::fs::remove_file(&wav).await;

    state
        .dictation_stop_flag
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let stop_flag = state.dictation_stop_flag.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let r = tokio::task::spawn_blocking(move || audio::record_dictation_clip(wav, stop_flag)).await;
        match r {
            Ok(Ok(())) => {}
            Ok(Err(e)) => eprintln!("[dictation] capture error: {}", e),
            Err(e) => eprintln!("[dictation] capture panicked: {:?}", e),
        }
    });
    *state.dictation_handle.lock().await = Some(handle);

    let _ = app.emit("dictation-status-changed", serde_json::json!({ "status": "recording" }));
    Ok(())
}

#[tauri::command]
async fn stop_dictation(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    if !*state.dictation_active.lock().unwrap() {
        return Err("Aucune dictée en cours.".to_string());
    }

    state
        .dictation_stop_flag
        .store(true, std::sync::atomic::Ordering::SeqCst);
    if let Some(handle) = state.dictation_handle.lock().await.take() {
        let _ = handle.await;
    }

    let _ = app.emit("dictation-status-changed", serde_json::json!({ "status": "transcribing" }));

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let wav = dictation_wav_path(&data_dir);
    let result = transcription::transcribe_wav_text(&wav, &state.db, &data_dir, state.resource_dir.as_deref()).await;

    // Éphémère : le clip est supprimé quoi qu'il arrive (spec/07b).
    let _ = tokio::fs::remove_file(&wav).await;
    *state.dictation_active.lock().unwrap() = false;

    match result {
        Ok(text) => {
            let _ = app.emit("dictation-status-changed", serde_json::json!({ "status": "done" }));
            Ok(text)
        }
        Err(e) => {
            let _ = app.emit(
                "dictation-status-changed",
                serde_json::json!({ "status": "error", "message": e.to_string() }),
            );
            Err(e.to_string())
        }
    }
}

/// Annule la dictée sans transcrire (fermeture du popover, navigation…).
#[tauri::command]
async fn cancel_dictation(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if !*state.dictation_active.lock().unwrap() {
        return Ok(());
    }
    state
        .dictation_stop_flag
        .store(true, std::sync::atomic::Ordering::SeqCst);
    if let Some(handle) = state.dictation_handle.lock().await.take() {
        let _ = handle.await;
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let _ = tokio::fs::remove_file(dictation_wav_path(&data_dir)).await;
    *state.dictation_active.lock().unwrap() = false;
    let _ = app.emit("dictation-status-changed", serde_json::json!({ "status": "idle" }));
    Ok(())
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

    // Open the picker where Alfred's own recordings live (vault `alfred-raw/`),
    // so imports start in the expected folder. Falls back to the vault root, then
    // the OS default.
    let vault = state.vault_path.lock().unwrap().clone();
    let initial_dir = match vault {
        Some(root) => {
            let rec = root.join(transcription::recording_folder(&state.db).await);
            if rec.is_dir() {
                Some(rec)
            } else if root.is_dir() {
                Some(root)
            } else {
                None
            }
        }
        None => None,
    };

    let mut builder = app.dialog().file().add_filter("Audio WAV", &["wav"]);
    if let Some(dir) = initial_dir {
        builder = builder.set_directory(dir);
    }
    let picked = builder.blocking_pick_file();
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
        // Import = pipeline complet (pas de panneau de revue sur un import).
        true,
        true,
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
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    transcription::download_model(&size, &data_dir, &app, &state.downloads)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_whisper_models(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<transcription::WhisperModelInfo>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    transcription::list_whisper_models(
        &state.db,
        &data_dir,
        state.resource_dir.as_deref(),
        &state.downloads,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn cancel_model_download(size: String, state: tauri::State<'_, AppState>) {
    transcription::cancel_model_download(&size, &state.downloads);
}

#[tauri::command]
async fn delete_whisper_model(
    size: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    transcription::delete_whisper_model(&size, &state.db, &data_dir, &state.downloads)
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

/// Ouvre le portail de gestion d'abonnement Stripe (backend privé alfred-backend, spec/11) — gérer les
/// moyens de paiement, changer de formule, ou **annuler**.
#[tauri::command]
async fn manage_alfredia_subscription(state: tauri::State<'_, AppState>) -> Result<(), String> {
    subscription::open_billing_portal(&state.http_client)
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
        pending_action: response.pending_action,
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

/// TOUTES les tâches (cochées + Archivé), dans l'ordre du fichier — vue Kanban (spec/06).
#[tauri::command]
async fn get_all_todos(state: tauri::State<'_, AppState>) -> Result<Vec<todos::Todo>, String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    todos::get_all_todos(&state.db, vault_root.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Déplace une tâche vers une section / position (Kanban, spec/06).
#[tauri::command]
async fn move_todo(
    id: String,
    section: String,
    position: Option<usize>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    todos::move_todo(&id, &section, position, &state.db, vault_root.as_deref())
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

/// Édition complète depuis la fiche tâche (spec/06 2e passe) : title/
/// responsable/echeance/project/priority/estimate en un seul appel.
#[tauri::command]
async fn update_todo_fields(
    id: String,
    input: todos::TaskFieldsInput,
    state: tauri::State<'_, AppState>,
) -> Result<todos::Todo, String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    todos::update_todo_fields(&id, &input, &state.db, vault_root.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Réécrit le bloc d'une tâche — sous-puces + description (fiche tâche, spec/06 2e passe).
#[tauri::command]
async fn update_todo_block(
    id: String,
    notes: Vec<String>,
    description: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<todos::Todo, String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    todos::update_todo_block(&id, notes, description, &state.db, vault_root.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// « Rassembler le contexte pour cette tâche » (spec/06 2e passe, action IA à la
/// demande — jamais automatique) : réutilise la boucle agentique du chat
/// (spec/07b) avec une question synthétisée à partir de la tâche, sa provenance
/// et son projet. Ne persiste rien dans l'historique de conversation.
#[tauri::command]
async fn gather_task_context(
    title: String,
    project: Option<String>,
    source_note: Option<String>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ai::chat::ChatResponse, String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    // La question sert de signal de langue à `answer_question` (chat.rs :
    // « écris dans la MÊME langue que le texte fourni ») — la rédiger en dur en
    // français faisait répondre Claude en français même en UI anglaise
    // (feedback tests, même cause racine que spec/17/22 : la langue du CONTENU
    // envoyé prime sur `app_language`, donc le contenu doit déjà suivre `app_language`).
    let en = ai::app_language(&state.db).await == "en";
    let mut question = if en {
        format!("Gather the useful context to carry out this task: \"{}\". ", title)
    } else {
        format!("Rassemble le contexte utile pour réaliser cette tâche : « {} ». ", title)
    };
    if let Some(ref note) = source_note {
        if en {
            question.push_str(&format!("It comes from the summary \"{}\" — start by reading it. ", note));
        } else {
            question.push_str(&format!("Elle vient du compte-rendu « {} » — commence par le lire. ", note));
        }
    }
    if let Some(ref p) = project {
        if en {
            question.push_str(&format!("It's part of the \"{}\" project — also look up the other notes in that project. ", p));
        } else {
            question.push_str(&format!("Elle concerne le projet « {} » — retrouve aussi les autres notes de ce projet. ", p));
        }
    }
    question.push_str(if en {
        "Summarize in a few points what's worth knowing before getting started."
    } else {
        "Résume en quelques points ce qu'il faut savoir pour s'y mettre."
    });

    ai::chat::answer_question(question, vec![], vault_root, &state.db, &app)
        .await
        .map_err(|e| e.to_string())
}

/// Applique une action d'Alfred agentique déjà PROPOSÉE (lot / écrasement,
/// spec/22) une fois l'utilisateur ayant cliqué « Appliquer » sur la carte —
/// appelée directement par le front, sans repasser par Claude (carte locale,
/// esprit de `/resolve`). Rafraîchit Notes/Tâches via les mêmes événements que
/// l'ingestion. Retourne le nombre d'éléments effectivement modifiés.
#[tauri::command]
async fn confirm_agent_action(
    action: ai::agent_actions::ProposedAction,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let root = get_vault_root(&state)?;
    let count = ai::agent_actions::apply_action(&action, &root, &state.db)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit("notes-updated", serde_json::json!({}));
    let _ = app.emit("todos-updated", serde_json::json!({}));
    Ok(count)
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
async fn move_note_file(
    path: String,
    dest_folder: String,
    _state: tauri::State<'_, AppState>,
) -> Result<notes::NoteFile, String> {
    notes::vault::move_note_file(std::path::Path::new(&path), std::path::Path::new(&dest_folder))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_folder(
    parent: String,
    name: String,
    _state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    notes::vault::create_folder(std::path::Path::new(&parent), &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_folder(
    old_path: String,
    new_name: String,
    _state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    notes::vault::rename_folder(std::path::Path::new(&old_path), &new_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_folder(
    path: String,
    _state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    notes::vault::delete_folder(std::path::Path::new(&path))
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
    // Exclut `Contexte Alfred.md` et `Todo.md` (spec/07/16, feedback tests) :
    // ni l'un ni l'autre n'est une note d'« activité ». Le contexte voit sa
    // mtime avancer presque à chaque ingestion (context_additions auto-écrits
    // par `finalize_ingestion`), passant systématiquement devant le compte-rendu
    // qu'on vient réellement de produire ; Todo.md se rouvre déjà via la page
    // Tâches ou ses propres raccourcis.
    let exclude_paths = vec![
        root.join(notes::context::context_note_path(&state.db).await),
        root.join(todos::todo_file_path(&state.db).await),
    ];
    tokio::task::spawn_blocking(move || notes::vault::list_recent_notes(&root, limit, &exclude_paths))
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

/// Valeurs `project` distinctes du vault (combobox Projet + drag-drop, spec/07).
#[tauri::command]
async fn list_projects(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let root = get_vault_root(&state)?;
    tokio::task::spawn_blocking(move || notes::vault::list_projects(&root))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Tags distincts du vault (autocomplétion Properties, spec/07).
#[tauri::command]
async fn list_tags(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let root = get_vault_root(&state)?;
    tokio::task::spawn_blocking(move || notes::graph::list_tags(&root))
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
    context_additions: Vec<ai::ContextAddition>,
    vocab_terms: Option<Vec<String>>,
    confirmed_projects: Option<Vec<String>>,
    summary: Option<bool>,
    tasks: Option<bool>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    ai::finalize_ingestion(
        &recording_id,
        &corrected_text,
        &note_title,
        context_additions,
        vocab_terms.unwrap_or_default(),
        confirmed_projects.unwrap_or_default(),
        summary.unwrap_or(true),
        tasks.unwrap_or(true),
        &state.db,
        vault_root.as_deref(),
        &app,
    )
    .await
    .map_err(|e| e.to_string())
}

/// `recording_id`s ayant une vérification en attente (spec/17 §3/spec/07,
/// feedback tests) — le front croise cette liste avec le `recording_id` de
/// chaque note pour afficher l'indicateur « à vérifier » (arbre + Récents).
#[tauri::command]
async fn list_pending_clarifications(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    ai::pending_clarifications::list_recording_ids(&state.db)
        .await
        .map_err(|e| e.to_string())
}

/// La vérification déjà faite pour cette note (spec/17 §3, feedback tests) —
/// utilisé pour rouvrir `/resolve` sur un clic depuis l'indicateur, SANS
/// relancer `analyze_transcription` (le bouton « Vérifier / corriger » reste le
/// seul chemin qui relance volontairement une analyse).
#[tauri::command]
async fn get_pending_clarification(
    recording_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<ai::pending_clarifications::PendingClarification>, String> {
    ai::pending_clarifications::get(&state.db, &recording_id)
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
    ai::build_context_from_transcription(&recording_id, &text, None, &state.db, vault_root.as_deref(), &app)
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

/// Raw WAV bytes for a recording, for the "🔊 réécouter" button of the
/// resolution screen (spec/17 §3). Returns an ArrayBuffer to the front
/// (efficient — no base64/JSON-array bloat); the UI seeks to the segment.
///
/// Resolves by **`recording_id`**, not by note title (feedback tests — bug) :
/// the raw note's title is only ever the right wav-filename key while THAT
/// note is the one open. Once ingestion succeeds, the raw note is archived
/// (never renamed — the file is untouched) and the note actually open is
/// usually the compte-rendu, whose title differs → the old title-based lookup
/// built a path that never existed. `find_note_by_recording_id` finds the raw
/// note by its frontmatter `recording_id` regardless of which note is open or
/// of its `status`, then derives the wav filename from ITS stem.
#[tauri::command]
async fn read_recording_wav(
    recording_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    let vault_root = state
        .vault_path
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Vault non configuré".to_string())?;
    let folder = vault_root.join(transcription::recording_folder(&state.db).await);
    let note_path = notes::vault::find_note_by_recording_id(&folder, &recording_id)
        .ok_or_else(|| format!("Transcription introuvable pour cet enregistrement ({})", recording_id))?;
    let stem = note_path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let path = folder.join(format!("{}.wav", stem));
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
    let lang = ai::app_language(&state.db).await;
    notes::vault::scaffold_vault(&pb, &recording_folder, &intelligence_folder, &todo_rel_path, &lang)
        .await
        .map_err(|e| e.to_string())
}

/// Sème le contenu de démarrage (spec/13) — tâches checklist, notes de démo,
/// conversation d'exemple. Idempotent (flag `starter_content_seeded`) : ne
/// re-sème jamais, même si l'utilisateur a tout supprimé.
#[tauri::command]
async fn seed_starter_content(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    seed::seed_starter_content(&state.db, vault_root.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit("notes-updated", serde_json::json!({}));
    let _ = app.emit("todos-updated", serde_json::json!({}));
    Ok(())
}

/// Reste-t-il du contenu de démarrage à supprimer (spec/13/10) ? Vérifié en
/// direct (pas un simple drapeau) — piloté par le bandeau one-shot sur la
/// page Alfred.
#[tauri::command]
async fn has_starter_content(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    Ok(seed::has_starter_content(&state.db, vault_root.as_deref()).await)
}

/// Suppression one-shot du contenu de démarrage marqué (spec/13/10) — tâches
/// checklist, notes de démo, conversation d'exemple. Ne touche à rien d'autre.
#[tauri::command]
async fn delete_starter_content(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    seed::delete_starter_content(&state.db, vault_root.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit("notes-updated", serde_json::json!({}));
    let _ = app.emit("todos-updated", serde_json::json!({}));
    Ok(())
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
    summary: Option<bool>,
    tasks: Option<bool>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    ai::run_ingestion_for_note(
        std::path::Path::new(&note_path),
        summary.unwrap_or(true),
        tasks.unwrap_or(true),
        &state.db,
        vault_root.as_deref(),
        &app,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Frontend-callable anonymous metrics (backend privé alfred-backend §D) — thin wrapper over
/// `metrics::send`, for events only the UI can see (onboarding funnel, guided
/// tour, `/resolve` outcome). Fire-and-forget, same as the Rust-side call sites.
#[tauri::command]
fn track_event(event: String, props: Option<serde_json::Value>) {
    metrics::send(&event, props.unwrap_or_else(|| serde_json::json!({})));
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

// ─── E-mails (spec/24) ────────────────────────────────────────────────────────

#[tauri::command]
async fn connect_imap_account(host: String, port: u16, username: String, password: String, use_ssl: bool) -> Result<(), String> {
    email::connect_imap_account(host, port, username, password, use_ssl)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn disconnect_imap_account(state: tauri::State<'_, AppState>) -> Result<(), String> {
    email::disconnect_imap_account(&state.db).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_imap_status(state: tauri::State<'_, AppState>) -> Result<email::ImapStatus, String> {
    email::get_imap_status(&state.db).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn sync_emails(state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let vault_root = state.vault_path.lock().unwrap().clone();
    email::sync_emails(&state.db, vault_root.as_deref(), &app)
        .await
        .map_err(|e| e.to_string())
}

// ─── System commands ──────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
#[tauri::command]
fn get_launch_at_login() -> Result<bool, String> {
    let plist_path = dirs::home_dir()
        .map(|h| h.join("Library/LaunchAgents/com.alfred.app.plist"))
        .ok_or("Cannot determine home dir")?;
    Ok(plist_path.exists())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn set_launch_at_login(enabled: bool) -> Result<(), String> {
    let plist_path = dirs::home_dir()
        .map(|h| h.join("Library/LaunchAgents/com.alfred.app.plist"))
        .ok_or("Cannot determine home dir")?;

    if enabled {
        let plist = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.alfred.app</string>
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

            // Nettoyage vestige (spec/07/11, feedback tests) : `scaffold_vault`
            // n'était appelé qu'à la sélection explicite du dossier (onboarding/
            // Réglages) — un utilisateur déjà configuré avant cette migration ne
            // la déclencherait jamais. Rejoué à chaque lancement pour un vault
            // déjà connu ; idempotent (no-op une fois le legacy `raw/`/`wiki/`
            // parti), jamais bloquant.
            if let Some(vp) = vault_path.clone() {
                let db2 = db.clone();
                tauri::async_runtime::block_on(async move {
                    let recording_folder = transcription::recording_folder(&db2).await;
                    let intelligence_folder = ai::intelligence_folder(&db2).await;
                    let todo_rel_path = todos::todo_file_path(&db2).await;
                    let lang = ai::app_language(&db2).await;
                    if let Err(e) = notes::vault::scaffold_vault(&vp, &recording_folder, &intelligence_folder, &todo_rel_path, &lang).await {
                        eprintln!("[setup] scaffold_vault (startup re-check) failed: {}", e);
                    }
                });
            }

            let http_client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("Cannot build HTTP client");

            let state = AppState {
                db: db.clone(),
                recording_handle: Arc::new(Mutex::new(None)),
                active_recording_id: Arc::new(StdMutex::new(None)),
                recording_stop_flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                recording_pause_flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                dictation_active: Arc::new(StdMutex::new(false)),
                dictation_stop_flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                dictation_handle: Arc::new(Mutex::new(None)),
                transcription_tx,
                downloads: Arc::new(StdMutex::new(std::collections::HashMap::new())),
                http_client: http_client.clone(),
                resource_dir,
                vault_path: Arc::new(StdMutex::new(vault_path.clone())),
            };

            app.manage(state);

            // Anonymous usage metrics (backend privé alfred-backend): install_id + install_created/app_launched.
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

            // Sync e-mails une fois au lancement (spec/24 §2) — no-op silencieux
            // si aucun compte IMAP n'est configuré. Pas de polling périodique.
            {
                let db_email = db.clone();
                let vault_root = vault_path.clone();
                let app_handle_email = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = email::sync_emails(&db_email, vault_root.as_deref(), &app_handle_email).await {
                        eprintln!("[email] startup sync failed: {}", e);
                    }
                });
            }

            let _ = app_handle; // kept for future setup steps

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Recording
            start_recording,
            stop_recording,
            cancel_recording,
            discard_recording,
            process_recording,
            pause_recording,
            resume_recording,
            test_microphone,
            import_audio_file,
            // Dictée éphémère (spec/07b)
            start_dictation,
            stop_dictation,
            cancel_dictation,
            // Transcription
            download_model,
            list_whisper_models,
            cancel_model_download,
            delete_whisper_model,
            get_transcription,
            // AI
            test_api_key,
            ask_notes,
            confirm_agent_action,
            list_chat_conversations,
            get_chat_messages,
            delete_chat_conversation,
            generate_daily_brief,
            get_daily_brief,
            submit_feedback,
            subscribe_alfredia,
            manage_alfredia_subscription,
            // Todos
            get_todos,
            get_all_todos,
            create_todo,
            complete_todo,
            dismiss_todo,
            update_todo,
            update_todo_fields,
            update_todo_block,
            gather_task_context,
            move_todo,
            // Notes (vault)
            get_vault_tree,
            get_note_file,
            create_note_file,
            update_note_file,
            delete_note_file,
            rename_note_file,
            move_note_file,
            create_folder,
            rename_folder,
            delete_folder,
            get_recent_notes,
            get_notes_by_project,
            get_vault_graph,
            list_projects,
            list_tags,
            get_vault_path,
            set_vault_path,
            pick_vault_folder,
            seed_starter_content,
            has_starter_content,
            delete_starter_content,
            open_context_note,
            generate_glossary_from_context,
            analyze_transcription,
            finalize_ingestion,
            list_pending_clarifications,
            get_pending_clarification,
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
            track_event,
            run_ingest,
            get_todo_file,
            get_recording_folder,
            get_secret,
            save_secret,
            // E-mails (spec/24)
            connect_imap_account,
            disconnect_imap_account,
            get_imap_status,
            sync_emails,
            // System
            get_launch_at_login,
            set_launch_at_login,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
