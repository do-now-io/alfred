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
    pub transcription_tx: mpsc::Sender<TranscriptionJob>,
    pub http_client: reqwest::Client,
    pub resource_dir: Option<std::path::PathBuf>,
    pub vault_path: Arc<StdMutex<Option<std::path::PathBuf>>>,
}
