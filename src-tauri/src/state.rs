use sqlx::SqlitePool;
use std::sync::{Arc, Mutex as StdMutex};
use std::sync::atomic::AtomicBool;
use tokio::sync::{mpsc, Mutex};

use crate::transcription::TranscriptionJob;

pub struct AppState {
    pub db: SqlitePool,
    pub recording_handle: Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    pub active_recording_id: Arc<StdMutex<Option<String>>>,
    pub recording_stop_flag: Arc<AtomicBool>,
    /// Pause/reprise de la capture (spec/03/13) : quand levé, les frames sont
    /// jetées et le chrono se fige — la prise n'est pas clôturée.
    pub recording_pause_flag: Arc<AtomicBool>,
    /// Dictée éphémère (spec/07b) : capture micro courte → texte, sans note ni
    /// ligne `recordings`. Exclusive de l'enregistrement (capture = singleton).
    pub dictation_active: Arc<StdMutex<bool>>,
    pub dictation_stop_flag: Arc<AtomicBool>,
    pub dictation_handle: Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    pub transcription_tx: mpsc::Sender<TranscriptionJob>,
    pub http_client: reqwest::Client,
    pub resource_dir: Option<std::path::PathBuf>,
    pub vault_path: Arc<StdMutex<Option<std::path::PathBuf>>>,
}
