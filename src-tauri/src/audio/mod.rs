use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::transcription::{TranscriptionJob, TranscriptionSender};

pub async fn start_recording(
    source: &str,
    data_dir: PathBuf,
    db: SqlitePool,
    app_handle: tauri::AppHandle,
    recording_handle: Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    active_recording_id: Arc<StdMutex<Option<String>>>,
    stop_flag: Arc<AtomicBool>,
    transcription_tx: TranscriptionSender,
) -> Result<()> {
    // Reset stop flag
    stop_flag.store(false, Ordering::SeqCst);

    let recording_id = Uuid::new_v4().to_string();
    let file_path = data_dir.join("recordings").join(format!("{}.wav", recording_id));
    tokio::fs::create_dir_all(file_path.parent().unwrap()).await?;

    let now = chrono::Utc::now().to_rfc3339();
    let source_str = source.to_string();
    let file_path_str = file_path.to_string_lossy().to_string();
    sqlx::query!(
        "INSERT INTO recordings (id, file_path, recorded_at, source, status) VALUES (?, ?, ?, ?, 'recording')",
        recording_id, file_path_str, now, source_str
    )
    .execute(&db)
    .await?;

    *active_recording_id.lock().unwrap() = Some(recording_id.clone());

    let app = app_handle.clone();
    let file_path_clone = file_path.clone();
    let stop_flag_clone = stop_flag.clone();

    // spawn_blocking runs the synchronous cpal capture off the async executor
    let handle = tauri::async_runtime::spawn(async move {
        let result = tokio::task::spawn_blocking(move || {
            record_audio(file_path_clone, stop_flag_clone, app.clone())
        })
        .await;

        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => eprintln!("Recording error: {}", e),
            Err(e)     => eprintln!("Recording task panicked: {:?}", e),
        }
    });

    *recording_handle.lock().await = Some(handle);

    app_handle.emit("recording-status-changed", serde_json::json!({
        "status": "recording",
        "duration_seconds": 0
    }))?;

    Ok(())
}

fn record_audio(
    file_path: PathBuf,
    stop_flag: Arc<AtomicBool>,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| anyhow!("No input device found"))?;

    // Use the device's native config — avoids "sample rate out of range" panic
    let config = device.default_input_config()
        .map_err(|e| anyhow!("Cannot get input config: {}", e))?;

    let sample_rate = config.sample_rate().0;
    let channels   = config.channels() as usize;

    eprintln!("[audio] device={:?} sample_rate={} channels={}",
        device.name().unwrap_or_default(), sample_rate, channels);

    // Write WAV at the native sample rate; transcription module resamples to 16 kHz
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let writer = Arc::new(StdMutex::new(Some(
        WavWriter::create(&file_path, spec).map_err(|e| anyhow!("WavWriter: {}", e))?,
    )));
    let writer_clone = writer.clone();
    let stop_clone   = stop_flag.clone();

    let err_fn = |err| eprintln!("[audio] stream error: {}", err);

    let stream = device.build_input_stream(
        &config.into(),
        move |data: &[f32], _: &cpal::InputCallbackInfo| {
            if stop_clone.load(Ordering::Relaxed) {
                return;
            }
            let mut guard = writer_clone.lock().unwrap();
            if let Some(ref mut w) = *guard {
                // Mix down to mono
                let mono = if channels == 1 {
                    data.iter().copied().collect::<Vec<_>>()
                } else {
                    data.chunks(channels)
                        .map(|ch| ch.iter().sum::<f32>() / channels as f32)
                        .collect()
                };
                for s in mono {
                    let _ = w.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
                }
            }
        },
        err_fn,
        None,
    ).map_err(|e| anyhow!("build_input_stream: {}", e))?;

    stream.play().map_err(|e| anyhow!("stream.play: {}", e))?;
    eprintln!("[audio] recording started");

    // Block until stop is requested
    while !stop_flag.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    eprintln!("[audio] stop requested — finalising WAV");
    drop(stream);

    // Finalize WAV file
    if let Some(w) = writer.lock().unwrap().take() {
        w.finalize().map_err(|e| anyhow!("WAV finalize: {}", e))?;
    }

    eprintln!("[audio] WAV written to {:?}", file_path);

    app_handle.emit("recording-status-changed", serde_json::json!({
        "status": "processing",
        "duration_seconds": 0
    }))?;

    Ok(())
}

pub async fn stop_recording(
    data_dir: &PathBuf,
    resource_dir: Option<PathBuf>,
    vault_path: Option<PathBuf>,
    active_recording_id: Arc<StdMutex<Option<String>>>,
    stop_flag: Arc<AtomicBool>,
    recording_handle: Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    db: SqlitePool,
    transcription_tx: TranscriptionSender,
    app_handle: tauri::AppHandle,
) -> Result<String> {
    let recording_id = active_recording_id
        .lock().unwrap().take()
        .ok_or_else(|| anyhow!("No active recording"))?;

    // Signal the recording thread to stop
    stop_flag.store(true, Ordering::SeqCst);

    // Wait for the recording task to finish writing the WAV
    if let Some(handle) = recording_handle.lock().await.take() {
        let _ = handle.await;
    }

    eprintln!("[audio] recording task finished");

    sqlx::query!(
        "UPDATE recordings SET status = 'processing' WHERE id = ?",
        recording_id
    )
    .execute(&db)
    .await?;

    let file_path = data_dir.join("recordings").join(format!("{}.wav", recording_id));

    // Verify the file exists before queueing transcription
    if !file_path.exists() {
        return Err(anyhow!("WAV file not found after recording: {:?}", file_path));
    }

    let model = sqlx::query_scalar!("SELECT value FROM config WHERE key = 'whisper_model'")
        .fetch_optional(&db).await?
        .unwrap_or_else(|| "small".to_string());

    let lang = sqlx::query_scalar!("SELECT value FROM config WHERE key = 'language_hint'")
        .fetch_optional(&db).await?
        .unwrap_or_else(|| "auto".to_string());

    let job = TranscriptionJob {
        recording_id: recording_id.clone(),
        file_path,
        model_size: model,
        language: if lang == "auto" { None } else { Some(lang) },
        db,
        app_handle,
        data_dir: data_dir.clone(),
        resource_dir,
        vault_path,
    };

    transcription_tx.send(job).await.map_err(|e| anyhow!("{}", e))?;
    Ok(recording_id)
}

/// Briefly open the default input device to verify microphone access. On macOS
/// this also triggers the OS permission prompt the first time. Returns Ok if a
/// stream can be built and started, Err otherwise. Used by the onboarding wizard.
pub async fn test_microphone() -> Result<()> {
    tokio::task::spawn_blocking(|| -> Result<()> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| anyhow!("Aucun micro détecté"))?;
        let config = device
            .default_input_config()
            .map_err(|e| anyhow!("Config micro indisponible: {}", e))?;

        let err_fn = |err| eprintln!("[audio/test] stream error: {}", err);
        let stream = device
            .build_input_stream(
                &config.into(),
                move |_data: &[f32], _: &cpal::InputCallbackInfo| {},
                err_fn,
                None,
            )
            .map_err(|e| anyhow!("Impossible d'ouvrir le micro: {}", e))?;
        stream.play().map_err(|e| anyhow!("Lecture micro: {}", e))?;
        std::thread::sleep(std::time::Duration::from_millis(800));
        drop(stream);
        Ok(())
    })
    .await?
}
