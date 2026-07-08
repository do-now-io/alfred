use anyhow::{anyhow, Result};
use chrono::Timelike;
use chrono::Datelike;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::path::PathBuf;
use tauri::Emitter;
use tokio::sync::mpsc;
use uuid::Uuid;

pub type TranscriptionSender = mpsc::Sender<TranscriptionJob>;

pub struct TranscriptionJob {
    pub recording_id: String,
    pub file_path: PathBuf,
    pub model_size: String,
    pub language: Option<String>,
    pub db: SqlitePool,
    pub app_handle: tauri::AppHandle,
    pub data_dir: PathBuf,
    /// Path to the app bundle Resources folder (Alfred.app/Contents/Resources)
    pub resource_dir: Option<PathBuf>,
    /// Path to the notes vault (for creating transcription notes)
    pub vault_path: Option<PathBuf>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WhisperSegment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

pub async fn run_transcription_worker(mut rx: mpsc::Receiver<TranscriptionJob>) {
    while let Some(job) = rx.recv().await {
        if let Err(e) = process_job(job).await {
            eprintln!("Transcription error: {}", e);
        }
    }
}

/// Look for the model in (priority order):
/// 1. Alfred.app/Contents/Resources/models/  — bundled at build time
/// 2. $APP_DATA_DIR/models/                  — downloaded by the user
fn resolve_model_path(job: &TranscriptionJob) -> Result<PathBuf> {
    let filename = format!("ggml-{}.bin", job.model_size);

    if let Some(ref res_dir) = job.resource_dir {
        let bundled = res_dir.join("models").join(&filename);
        if bundled.exists() {
            return Ok(bundled);
        }
    }

    let user_path = job.data_dir.join("models").join(&filename);
    if user_path.exists() {
        return Ok(user_path);
    }

    Err(anyhow!(
        "Model '{}' not found. Bundle it in the app or download it from Settings.",
        filename
    ))
}

async fn process_job(job: TranscriptionJob) -> Result<()> {
    let recording_id = job.recording_id.clone();

    job.app_handle.emit("transcription-progress", serde_json::json!({
        "recording_id": recording_id,
        "percent": 0
    }))?;

    let model_path = resolve_model_path(&job)?;
    eprintln!("[transcription] using model at {:?}", model_path);

    let file_path = job.file_path.clone();
    let model_path_clone = model_path.clone();
    let language = job.language.clone();

    // Run Whisper inference in a blocking thread (CPU-bound)
    let (raw_text, segments) = tokio::task::spawn_blocking(move || {
        run_whisper(&file_path, &model_path_clone, language.as_deref())
    })
    .await??;

    let now = chrono::Utc::now().to_rfc3339();
    let transcription_id = Uuid::new_v4().to_string();
    let segments_json = serde_json::to_string(&segments)?;
    let model_size = job.model_size.clone();

    sqlx::query!(
        r#"INSERT INTO transcriptions
           (id, recording_id, raw_text, segments_json, whisper_model, processed_at)
           VALUES (?, ?, ?, ?, ?, ?)"#,
        transcription_id,
        recording_id,
        raw_text,
        segments_json,
        model_size,
        now
    )
    .execute(&job.db)
    .await?;

    sqlx::query!(
        "UPDATE recordings SET status = 'done' WHERE id = ?",
        recording_id
    )
    .execute(&job.db)
    .await?;

    // Use the same title for both the markdown note and the audio file
    let note_title = format_note_title();
    // Configurable destination folder (vault-relative) for the audio + transcription note.
    let rec_folder = recording_folder(&job.db).await;

    // Move WAV to the recording folder — or delete if no vault configured
    if let Some(ref vault_root) = job.vault_path {
        let audio_dir = vault_root.join(&rec_folder);
        let _ = tokio::fs::create_dir_all(&audio_dir).await;
        let dest = audio_dir.join(format!("{}.wav", note_title));
        if tokio::fs::rename(&job.file_path, &dest).await.is_err() {
            // rename fails across filesystems — fall back to copy + delete
            if tokio::fs::copy(&job.file_path, &dest).await.is_ok() {
                let _ = tokio::fs::remove_file(&job.file_path).await;
            } else {
                let _ = tokio::fs::remove_file(&job.file_path).await;
            }
        }
    } else if job.file_path.exists() {
        let _ = tokio::fs::remove_file(&job.file_path).await;
    }

    // Create a note in the vault
    if let Some(ref vault_root) = job.vault_path {
        match crate::notes::vault::create_recording_note(
            &vault_root.join(&rec_folder),
            &note_title,
            &recording_id,
            raw_text.trim(),
        ).await {
            Ok(_) => {
                eprintln!("[transcription] vault note created: {}", note_title);
                let _ = job.app_handle.emit("notes-updated", serde_json::json!({}));
            }
            Err(e) => eprintln!("[transcription] failed to create vault note: {}", e),
        }
    } else {
        eprintln!("[transcription] vault not configured, skipping note creation");
    }

    job.app_handle.emit("transcription-progress", serde_json::json!({
        "recording_id": recording_id,
        "percent": 100
    }))?;

    job.app_handle.emit("transcription-complete", serde_json::json!({
        "recording_id": recording_id,
        "transcription_id": transcription_id
    }))?;

    // Trigger AI todo extraction
    let db_clone = job.db.clone();
    let app_clone = job.app_handle.clone();
    let t_id = transcription_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::ai::extract_todos_from_transcription(&t_id, &db_clone, &app_clone).await {
            eprintln!("Todo extraction error: {}", e);
        }
    });

    Ok(())
}

/// Vault-relative folder where recordings (audio + transcription note) are stored.
pub const DEFAULT_RECORDING_FOLDER: &str = "raw/audios";

/// The configured recording folder (vault-relative), or the default. Reuses the same
/// `SELECT value FROM config` query as the other config readers (offline `.sqlx` cache).
pub async fn recording_folder(db: &SqlitePool) -> String {
    let key = "recording_folder";
    let stored: Option<String> = sqlx::query_scalar!("SELECT value FROM config WHERE key = ?", key)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    stored
        .map(|s| s.trim().trim_matches('/').trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_RECORDING_FOLDER.to_string())
}

fn format_note_title() -> String {
    let now = chrono::Local::now();
    format!(
        "{}-{:02}-{:02} {:02}h{:02}",
        now.year(),
        now.month(),
        now.day(),
        now.hour(),
        now.minute()
    )
}

fn run_whisper(
    file_path: &PathBuf,
    model_path: &PathBuf,
    language: Option<&str>,
) -> Result<(String, Vec<WhisperSegment>)> {
    // Read WAV file
    let reader = hound::WavReader::open(file_path)?;
    let spec = reader.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .into_samples::<f32>()
            .map(|s| s.map_err(|e| anyhow!("{}", e)))
            .collect::<Result<Vec<_>>>()?,
        hound::SampleFormat::Int => reader
            .into_samples::<i16>()
            .map(|s| s.map(|v| v as f32 / i16::MAX as f32).map_err(|e| anyhow!("{}", e)))
            .collect::<Result<Vec<_>>>()?,
    };

    // Resample to 16kHz if needed
    let samples_16k = if spec.sample_rate != 16000 {
        resample(&samples, spec.sample_rate, 16000)?
    } else {
        samples
    };

    #[cfg(feature = "whisper")]
    {
        // Initialize Whisper
        let mut params = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_translate(false);
        params.set_n_threads(std::thread::available_parallelism()?.get().min(4) as i32);

        // No forced language → "auto" so Whisper detects the spoken language and
        // transcribes in it. Without this, whisper.cpp defaults to "en" and treats
        // all audio as English (see spec/04-transcription.md).
        params.set_language(Some(language.unwrap_or("auto")));

        let ctx = whisper_rs::WhisperContext::new_with_params(
            model_path.to_str().ok_or_else(|| anyhow!("Invalid model path"))?,
            whisper_rs::WhisperContextParameters::default(),
        )
        .map_err(|e| anyhow!("Failed to load Whisper model: {:?}", e))?;

        let mut state = ctx.create_state().map_err(|e| anyhow!("{:?}", e))?;
        state
            .full(params, &samples_16k)
            .map_err(|e| anyhow!("{:?}", e))?;

        let num_segments = state.full_n_segments().map_err(|e| anyhow!("{:?}", e))?;
        let mut raw_parts = Vec::new();
        let mut segments = Vec::new();

        for i in 0..num_segments {
            let text = state.full_get_segment_text(i).map_err(|e| anyhow!("{:?}", e))?;
            let t0 = state.full_get_segment_t0(i).map_err(|e| anyhow!("{:?}", e))? as f64 / 100.0;
            let t1 = state.full_get_segment_t1(i).map_err(|e| anyhow!("{:?}", e))? as f64 / 100.0;
            raw_parts.push(text.trim().to_string());
            segments.push(WhisperSegment {
                start: t0,
                end: t1,
                text: text.trim().to_string(),
            });
        }

        return Ok((raw_parts.join(" "), segments));
    }

    // Stub when whisper feature is disabled
    #[allow(unreachable_code)]
    {
        let _ = (samples_16k, model_path, language);
        Err(anyhow!(
            "Whisper not compiled. Enable the 'whisper' feature or download a model."
        ))
    }
}

fn resample(samples: &[f32], from_rate: u32, to_rate: u32) -> Result<Vec<f32>> {
    use rubato::{FftFixedInOut, Resampler};

    let mut resampler = FftFixedInOut::<f32>::new(
        from_rate as usize,
        to_rate as usize,
        1024, // hint — resampler may adjust to satisfy ratio constraints
        1,
    )?;

    // Ask the resampler for the chunk size it actually requires
    let chunk_size = resampler.input_frames_next();
    let ratio = to_rate as f64 / from_rate as f64;

    let mut output = Vec::new();
    let mut pos = 0;

    while pos + chunk_size <= samples.len() {
        let out = resampler.process(&[samples[pos..pos + chunk_size].to_vec()], None)?;
        output.extend_from_slice(&out[0]);
        pos += chunk_size;
    }

    // Pad the last partial chunk with silence and trim the output
    if pos < samples.len() {
        let remaining = samples.len() - pos;
        let mut chunk = samples[pos..].to_vec();
        chunk.resize(chunk_size, 0.0);
        let out = resampler.process(&[chunk], None)?;
        let keep = (remaining as f64 * ratio).ceil() as usize;
        output.extend_from_slice(&out[0][..keep.min(out[0].len())]);
    }

    Ok(output)
}

pub async fn download_model(
    size: &str,
    data_dir: &PathBuf,
    app_handle: &tauri::AppHandle,
) -> Result<()> {
    let model_dir = data_dir.join("models");
    tokio::fs::create_dir_all(&model_dir).await?;

    let model_path = model_dir.join(format!("ggml-{}.bin", size));
    if model_path.exists() {
        return Ok(());
    }

    let url = format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{}.bin",
        size
    );

    // Download to a `.part` file and rename on success, so a failed/interrupted
    // download never leaves a corrupt file at `model_path` that `exists()` would
    // then treat as complete.
    let part_path = model_dir.join(format!("ggml-{}.bin.part", size));

    let client = reqwest::Client::new();
    let mut resp = client.get(&url).send().await?.error_for_status()?;

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut file = tokio::fs::File::create(&part_path).await?;

    let download_result: Result<()> = async {
        while let Some(chunk) = resp.chunk().await? {
            tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await?;
            downloaded += chunk.len() as u64;
            let percent = if total > 0 {
                (downloaded * 100 / total) as f64
            } else {
                0.0
            };
            let _ = app_handle.emit("download-progress", serde_json::json!({
                "percent": percent,
                "bytes_downloaded": downloaded,
                "total_bytes": total
            }));
        }
        Ok(())
    }
    .await;

    if let Err(e) = download_result {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(e);
    }

    tokio::fs::rename(&part_path, &model_path).await?;
    Ok(())
}

pub async fn get_transcription(recording_id: &str, db: &SqlitePool) -> Result<Option<serde_json::Value>> {
    let row = sqlx::query!(
        "SELECT id, raw_text, segments_json, language, whisper_model, processed_at FROM transcriptions WHERE recording_id = ?",
        recording_id
    )
    .fetch_optional(db)
    .await?;

    Ok(row.map(|r| serde_json::json!({
        "id": r.id,
        "raw_text": r.raw_text,
        "segments": serde_json::from_str::<serde_json::Value>(&r.segments_json).unwrap_or_default(),
        "language": r.language,
        "whisper_model": r.whisper_model,
        "processed_at": r.processed_at
    })))
}
