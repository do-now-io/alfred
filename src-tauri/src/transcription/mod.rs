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
    /// Whisper decoding threads (spec/17 §2); `None` → `min(cores, 4)`.
    pub threads: Option<usize>,
    /// Derived glossary injected as Whisper's `initial_prompt` (spec/17 §1).
    pub initial_prompt: Option<String>,
    /// "meeting" (default → compte-rendu + tâches) or "context" (visite guidée →
    /// construit `Contexte Alfred.md` + glossaire, pas de compte-rendu). spec/13.
    pub purpose: String,
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

/// Build a `TranscriptionJob` from a ready WAV and push it onto the worker queue.
/// Reads the decoding config (model, language hint, threads, derived glossary)
/// shared by every entry point — live `stop_recording` and audio-file import
/// alike — so the two never drift apart. The WAV at `file_path` must already sit
/// at `$APP_DATA_DIR/recordings/{recording_id}.wav`.
pub async fn enqueue_job(
    recording_id: String,
    file_path: PathBuf,
    db: SqlitePool,
    app_handle: tauri::AppHandle,
    data_dir: PathBuf,
    resource_dir: Option<PathBuf>,
    vault_path: Option<PathBuf>,
    tx: &TranscriptionSender,
) -> Result<()> {
    let model = sqlx::query_scalar!("SELECT value FROM config WHERE key = 'whisper_model'")
        .fetch_optional(&db).await?
        .unwrap_or_else(|| "small".to_string());

    let lang = sqlx::query_scalar!("SELECT value FROM config WHERE key = 'language_hint'")
        .fetch_optional(&db).await?
        .unwrap_or_else(|| "auto".to_string());

    // Threads relevables (spec/17 §2): config override, else run_whisper's min(cores, 4).
    let threads = sqlx::query_scalar!("SELECT value FROM config WHERE key = 'whisper_threads'")
        .fetch_optional(&db).await?
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|&t| t > 0);

    // Derived glossary (spec/17 §1) injected as Whisper's initial_prompt. Empty
    // until `generate_glossary_from_context` populates it.
    let glossary = sqlx::query_scalar!("SELECT value FROM config WHERE key = 'transcription_glossary'")
        .fetch_optional(&db).await?
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Recording purpose (spec/13) — dynamic query so the `purpose` column
    // (migration 010) isn't required in the compile-time dev DB.
    let purpose: String = sqlx::query_scalar("SELECT purpose FROM recordings WHERE id = ?")
        .bind(&recording_id)
        .fetch_optional(&db)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "meeting".to_string());

    let job = TranscriptionJob {
        recording_id,
        file_path,
        model_size: model,
        language: if lang == "auto" { None } else { Some(lang) },
        threads,
        initial_prompt: glossary,
        purpose,
        db,
        app_handle,
        data_dir,
        resource_dir,
        vault_path,
    };

    tx.send(job).await.map_err(|e| anyhow!("{}", e))?;
    Ok(())
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
    let threads = job.threads;
    let initial_prompt = job.initial_prompt.clone();

    // Run Whisper inference in a blocking thread (CPU-bound)
    let (raw_text, segments, detected_language) = tokio::task::spawn_blocking(move || {
        run_whisper(
            &file_path,
            &model_path_clone,
            language.as_deref(),
            threads,
            initial_prompt.as_deref(),
        )
    })
    .await??;

    let now = chrono::Utc::now().to_rfc3339();
    let transcription_id = Uuid::new_v4().to_string();
    let segments_json = serde_json::to_string(&segments)?;
    let model_size = job.model_size.clone();

    sqlx::query!(
        r#"INSERT INTO transcriptions
           (id, recording_id, raw_text, segments_json, language, whisper_model, processed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)"#,
        transcription_id,
        recording_id,
        raw_text,
        segments_json,
        detected_language,
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

    // Route the downstream by recording purpose (spec/13):
    //  - "context" → build `Contexte Alfred.md` + glossaire (no compte-rendu).
    //  - "meeting" (default) → the merged ingestion (compte-rendu + tasks, spec/05).
    let db_clone = job.db.clone();
    let app_clone = job.app_handle.clone();
    let vault_clone = job.vault_path.clone();
    let rec_id = recording_id.clone();
    let text = raw_text.clone();
    let title = note_title.clone();
    let purpose = job.purpose.clone();
    tauri::async_runtime::spawn(async move {
        if purpose == "context" {
            if let Err(e) = crate::ai::build_context_from_transcription(&rec_id, &text, &db_clone, vault_clone.as_deref(), &app_clone).await {
                eprintln!("Context build error: {}", e);
            }
        } else if let Err(e) = crate::ai::run_ingestion_for_recording(&rec_id, &text, &title, &db_clone, vault_clone.as_deref(), &app_clone).await {
            eprintln!("Ingestion error: {}", e);
        }
    });

    Ok(())
}

/// Vault-relative folder where recordings (audio + transcription note) are stored.
pub const DEFAULT_RECORDING_FOLDER: &str = "alfred-raw";

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

/// Decoding-quality knobs (spec/17 §2). Whisper `small` hallucinates on silences
/// and settles for a weak first guess with greedy sampling; beam search + these
/// anti-hallucination thresholds lift quality at ~1.5–2× the cost (absorbed by
/// threads; transcription is async at `stop`). Values are the whisper.cpp
/// defaults recommended in the spec — not user-tunable.
const BEAM_SIZE: i32 = 5;
const BEAM_PATIENCE: f32 = -1.0;
const NO_SPEECH_THOLD: f32 = 0.6;
const ENTROPY_THOLD: f32 = 2.4;
const LOGPROB_THOLD: f32 = -1.0;
const TEMPERATURE: f32 = 0.0;
const TEMPERATURE_INC: f32 = 0.2;
/// Default thread cap when config `whisper_threads` is unset (spec/04).
const DEFAULT_THREADS: usize = 4;

/// Returns (full text, segments, language) — the language is the user-forced
/// hint when set, else the one Whisper detected (spec/04's `transcriptions.language`).
///
/// `threads`: overrides the `min(cores, 4)` default (spec/17 — relevable to
/// absorb beam-search cost). `initial_prompt`: the derived glossary injected to
/// fix proper nouns at the source (spec/17 §1); ignored when empty.
fn run_whisper(
    file_path: &PathBuf,
    model_path: &PathBuf,
    language: Option<&str>,
    threads: Option<usize>,
    initial_prompt: Option<&str>,
) -> Result<(String, Vec<WhisperSegment>, Option<String>)> {
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
        // Beam search over greedy (spec/17 §2): better quality/effort ratio.
        let mut params = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::BeamSearch {
            beam_size: BEAM_SIZE,
            patience: BEAM_PATIENCE,
        });
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_translate(false);

        // Threads: config override (relevable to absorb beam cost) else min(cores, 4).
        let n_threads = threads
            .filter(|&t| t > 0)
            .unwrap_or_else(|| {
                std::thread::available_parallelism()
                    .map(|c| c.get())
                    .unwrap_or(DEFAULT_THREADS)
                    .min(DEFAULT_THREADS)
            });
        params.set_n_threads(n_threads as i32);

        // Anti-hallucination thresholds (spec/17 §2) — Whisper `small` invents
        // text on silences without these.
        params.set_no_speech_thold(NO_SPEECH_THOLD);
        params.set_entropy_thold(ENTROPY_THOLD);
        params.set_logprob_thold(LOGPROB_THOLD);
        params.set_temperature(TEMPERATURE);
        params.set_temperature_inc(TEMPERATURE_INC);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true); // suppress non-speech tokens

        // Glossary (spec/17 §1) — corrects proper nouns at the source. Skipped
        // when empty so we never feed Whisper a stray prompt.
        if let Some(prompt) = initial_prompt.map(str::trim).filter(|p| !p.is_empty()) {
            params.set_initial_prompt(prompt);
        }

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

        // Language: the forced hint when set, else Whisper's detection (spec/04 bug fix).
        let detected = match language {
            Some(l) if l != "auto" => Some(l.to_string()),
            _ => state
                .full_lang_id_from_state()
                .ok()
                .and_then(whisper_rs::get_lang_str)
                .map(|s| s.to_string()),
        };

        return Ok((raw_parts.join(" "), segments, detected));
    }

    // Stub when whisper feature is disabled
    #[allow(unreachable_code)]
    {
        let _ = (samples_16k, model_path, language, threads, initial_prompt);
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
