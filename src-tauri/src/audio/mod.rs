use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::Emitter;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::transcription::TranscriptionSender;

#[cfg(target_os = "windows")]
pub mod wasapi_loopback;

/// Common rate for `mixed` output — Whisper's native rate (see spec/04).
const MIX_SAMPLE_RATE: u32 = 16_000;

type WriterHandle = Arc<StdMutex<Option<WavWriter<std::io::BufWriter<std::fs::File>>>>>;

pub async fn start_recording(
    source: &str,
    data_dir: PathBuf,
    db: SqlitePool,
    app_handle: tauri::AppHandle,
    recording_handle: Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    active_recording_id: Arc<StdMutex<Option<String>>>,
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    _transcription_tx: TranscriptionSender,
) -> Result<()> {
    // System audio is Windows-only for now (macOS ScreenCaptureKit helper:
    // later). Repli gracieux (spec/03) : jamais d'échec au démarrage à cause
    // d'une source système indisponible — on retombe silencieusement sur le
    // micro seul plutôt que de refuser l'enregistrement.
    #[cfg(not(target_os = "windows"))]
    let source = "mic_only";

    // Reset stop & pause flags
    stop_flag.store(false, Ordering::SeqCst);
    pause_flag.store(false, Ordering::SeqCst);

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

    let file_path_clone = file_path.clone();
    let stop_flag_clone = stop_flag.clone();
    let pause_flag_clone = pause_flag.clone();
    let source_owned = source.to_string();

    // spawn_blocking runs the synchronous capture off the async executor.
    // No status is emitted when the capture ends: `stop_recording` (revue) and
    // `cancel_recording` (idle) each announce the state they lead to (spec/03).
    let app_for_capture = app_handle.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let result = tokio::task::spawn_blocking(move || {
            run_capture(&source_owned, file_path_clone, stop_flag_clone, pause_flag_clone, app_for_capture)
        })
        .await;

        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => eprintln!("Recording error: {}", e),
            Err(e) => eprintln!("Recording task panicked: {:?}", e),
        }
    });

    *recording_handle.lock().await = Some(handle);

    app_handle.emit("recording-status-changed", serde_json::json!({
        "status": "recording",
        "duration_seconds": 0
    }))?;

    Ok(())
}

/// Blocking dispatch by recording source. Produces the final WAV at `final_path`.
fn run_capture(source: &str, final_path: PathBuf, stop_flag: Arc<AtomicBool>, pause_flag: Arc<AtomicBool>, app_handle: tauri::AppHandle) -> Result<()> {
    match source {
        "system_only" => {
            #[cfg(target_os = "windows")]
            {
                let _ = &app_handle; // no live volume meter for system-audio capture yet
                wasapi_loopback::record_system_audio(final_path, stop_flag, pause_flag)
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err(anyhow!("Audio système non disponible sur cette plateforme"))
            }
        }
        "mixed" => {
            #[cfg(target_os = "windows")]
            {
                record_mixed(final_path, stop_flag, pause_flag, app_handle)
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err(anyhow!("Audio système non disponible sur cette plateforme"))
            }
        }
        // "mic_only" and anything unknown: microphone.
        _ => record_microphone(final_path, stop_flag, pause_flag, Some(app_handle)),
    }
}

/// Windows `mixed`: mic and system are captured to two temp WAVs in parallel,
/// then mixed into `final_path` at stop. Offline mixing avoids realtime
/// clock-sync issues between the two streams. If one capture fails, the other
/// is salvaged as-is.
#[cfg(target_os = "windows")]
fn record_mixed(final_path: PathBuf, stop_flag: Arc<AtomicBool>, pause_flag: Arc<AtomicBool>, app_handle: tauri::AppHandle) -> Result<()> {
    let mic_path = final_path.with_extension("mic.wav");
    let sys_path = final_path.with_extension("sys.wav");

    let sys_flag = stop_flag.clone();
    let sys_pause = pause_flag.clone();
    let sys_path_thread = sys_path.clone();
    let sys_thread = std::thread::spawn(move || {
        wasapi_loopback::record_system_audio(sys_path_thread, sys_flag, sys_pause)
    });

    // Mic-only RMS is used as the volume meter's proxy for the mixed stream too.
    let mic_result = record_microphone(mic_path.clone(), stop_flag, pause_flag, Some(app_handle));
    let sys_result = sys_thread
        .join()
        .map_err(|_| anyhow!("System capture thread panicked"))?;

    let outcome = match (&mic_result, &sys_result) {
        (Ok(()), Ok(())) => {
            mix_wavs(&mic_path, &sys_path, &final_path)?;
            Ok(())
        }
        (Ok(()), Err(e)) => {
            eprintln!("[audio/mixed] system capture failed ({}), keeping mic only", e);
            std::fs::rename(&mic_path, &final_path)?;
            Ok(())
        }
        (Err(e), Ok(())) => {
            eprintln!("[audio/mixed] mic capture failed ({}), keeping system only", e);
            std::fs::rename(&sys_path, &final_path)?;
            Ok(())
        }
        (Err(e_mic), Err(e_sys)) => Err(anyhow!("mic: {} / system: {}", e_mic, e_sys)),
    };

    let _ = std::fs::remove_file(&mic_path);
    let _ = std::fs::remove_file(&sys_path);
    outcome
}

/// Capture the default input device into a mono PCM16 WAV at the device's
/// native rate. Handles f32 / i16 / u16 devices (some WASAPI inputs are i16 —
/// the old f32-only callback failed at runtime on those).
/// `app_handle: None` → capture silencieuse (aucun événement émis) — utilisée
/// par la dictée éphémère (spec/07b), qui a son propre canal d'état.
fn record_microphone(file_path: PathBuf, stop_flag: Arc<AtomicBool>, pause_flag: Arc<AtomicBool>, app_handle: Option<tauri::AppHandle>) -> Result<()> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| anyhow!("No input device found"))?;

    // Use the device's native config — avoids "sample rate out of range" panic
    let config = device
        .default_input_config()
        .map_err(|e| anyhow!("Cannot get input config: {}", e))?;

    let sample_rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let sample_format = config.sample_format();

    eprintln!(
        "[audio] device={:?} sample_rate={} channels={} format={:?}",
        device.name().unwrap_or_default(),
        sample_rate,
        channels,
        sample_format
    );

    // Write WAV at the native sample rate; transcription module resamples to 16 kHz
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let writer: WriterHandle = Arc::new(StdMutex::new(Some(
        WavWriter::create(&file_path, spec).map_err(|e| anyhow!("WavWriter: {}", e))?,
    )));
    // Live RMS level of the most recent buffer (spec/03 "feedback live"), shared
    // lock-free with the polling loop below via bit-cast (f32 has no atomic type).
    let level = Arc::new(AtomicU32::new(0));

    let err_fn = |err| eprintln!("[audio] stream error: {}", err);
    let stream_config: cpal::StreamConfig = config.into();

    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            let (w, s, p, l) = (writer.clone(), stop_flag.clone(), pause_flag.clone(), level.clone());
            device.build_input_stream(
                &stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    write_frames(&w, &s, &p, &l, channels, data.iter().copied());
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let (w, s, p, l) = (writer.clone(), stop_flag.clone(), pause_flag.clone(), level.clone());
            device.build_input_stream(
                &stream_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    write_frames(&w, &s, &p, &l, channels, data.iter().map(|v| *v as f32 / i16::MAX as f32));
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let (w, s, p, l) = (writer.clone(), stop_flag.clone(), pause_flag.clone(), level.clone());
            device.build_input_stream(
                &stream_config,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    write_frames(&w, &s, &p, &l, channels, data.iter().map(|v| (*v as f32 / u16::MAX as f32) * 2.0 - 1.0));
                },
                err_fn,
                None,
            )
        }
        other => return Err(anyhow!("Unsupported input sample format: {:?}", other)),
    }
    .map_err(|e| anyhow!("build_input_stream: {}", e))?;

    stream.play().map_err(|e| anyhow!("stream.play: {}", e))?;
    eprintln!("[audio] recording started");

    // Block until stop is requested, emitting duration + volume every ~250ms
    // (spec/03 "feedback live") on top of the existing 50ms poll cadence.
    // While paused (spec/03/13), frames are dropped by `write_frames` and the
    // timer freezes: `paused_total` accumulates the paused wall-clock time,
    // subtracted from the elapsed duration.
    let started_at = std::time::Instant::now();
    let mut last_emit = std::time::Instant::now();
    let mut paused_total = std::time::Duration::ZERO;
    let mut paused_since: Option<std::time::Instant> = None;
    while !stop_flag.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let paused = pause_flag.load(Ordering::Relaxed);
        match (paused, paused_since) {
            (true, None) => paused_since = Some(std::time::Instant::now()),
            (false, Some(since)) => {
                paused_total += since.elapsed();
                paused_since = None;
            }
            _ => {}
        }
        if last_emit.elapsed() >= std::time::Duration::from_millis(250) {
            last_emit = std::time::Instant::now();
            let paused_now = paused_since.map(|s| s.elapsed()).unwrap_or_default();
            let effective = started_at.elapsed().saturating_sub(paused_total + paused_now);
            let volume = f32::from_bits(level.load(Ordering::Relaxed)).min(1.0);
            if let Some(ref app) = app_handle {
                let _ = app.emit("recording-status-changed", serde_json::json!({
                    "status": if paused { "paused" } else { "recording" },
                    "duration_seconds": effective.as_secs(),
                    "volume": if paused { 0.0 } else { volume }
                }));
            }
        }
    }

    eprintln!("[audio] stop requested — finalising WAV");
    drop(stream);

    // Finalize WAV file
    if let Some(w) = writer.lock().unwrap().take() {
        w.finalize().map_err(|e| anyhow!("WAV finalize: {}", e))?;
    }

    eprintln!("[audio] WAV written to {:?}", file_path);
    Ok(())
}

/// Downmix interleaved f32 frames to mono, append them as PCM16, and update the
/// shared RMS level (spec/03 "feedback live" volume meter). Paused → frames are
/// dropped (the capture stream keeps running, nothing is written).
fn write_frames(
    writer: &WriterHandle,
    stop_flag: &Arc<AtomicBool>,
    pause_flag: &Arc<AtomicBool>,
    level: &Arc<AtomicU32>,
    channels: usize,
    samples: impl Iterator<Item = f32>,
) {
    if stop_flag.load(Ordering::Relaxed) || pause_flag.load(Ordering::Relaxed) {
        return;
    }
    let data: Vec<f32> = samples.collect();
    let mono: Vec<f32> = if channels <= 1 {
        data
    } else {
        data.chunks(channels)
            .map(|ch| ch.iter().sum::<f32>() / channels as f32)
            .collect()
    };

    if !mono.is_empty() {
        let rms = (mono.iter().map(|s| s * s).sum::<f32>() / mono.len() as f32).sqrt();
        level.store(rms.to_bits(), Ordering::Relaxed);
    }

    let mut guard = writer.lock().unwrap();
    if let Some(ref mut w) = *guard {
        for s in &mono {
            let _ = w.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
        }
    }
}

// ─── Offline mixing (Windows `mixed` mode) ─────────────────────────────────────

/// Read a mono WAV into f32 samples (+ its sample rate).
#[cfg(target_os = "windows")]
fn read_wav_mono_f32(path: &Path) -> Result<(u32, Vec<f32>)> {
    let mut reader = hound::WavReader::open(path).map_err(|e| anyhow!("open {:?}: {}", path, e))?;
    let spec = reader.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => reader
            .samples::<i16>()
            .filter_map(|s| s.ok())
            .map(|s| s as f32 / i16::MAX as f32)
            .collect(),
        hound::SampleFormat::Float => reader.samples::<f32>().filter_map(|s| s.ok()).collect(),
    };
    Ok((spec.sample_rate, samples))
}

/// Linear-interpolation resampler — plenty for voice mixing (Whisper eats 16 kHz anyway).
#[cfg(target_os = "windows")]
fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = (input.len() as f64 / ratio).round() as usize;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let idx = pos as usize;
            let frac = (pos - idx as f64) as f32;
            let a = input[idx.min(input.len() - 1)];
            let b = input[(idx + 1).min(input.len() - 1)];
            a + (b - a) * frac
        })
        .collect()
}

/// Sum mic + system into one mono PCM16 WAV at `MIX_SAMPLE_RATE`.
#[cfg(target_os = "windows")]
fn mix_wavs(mic: &Path, sys: &Path, out: &Path) -> Result<()> {
    let (mic_rate, mic_samples) = read_wav_mono_f32(mic)?;
    let (sys_rate, sys_samples) = read_wav_mono_f32(sys)?;

    let mic16 = resample_linear(&mic_samples, mic_rate, MIX_SAMPLE_RATE);
    let sys16 = resample_linear(&sys_samples, sys_rate, MIX_SAMPLE_RATE);

    let spec = WavSpec {
        channels: 1,
        sample_rate: MIX_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = WavWriter::create(out, spec).map_err(|e| anyhow!("WavWriter mix: {}", e))?;

    let len = mic16.len().max(sys16.len());
    for i in 0..len {
        let m = mic16.get(i).copied().unwrap_or(0.0);
        let s = sys16.get(i).copied().unwrap_or(0.0);
        let mixed = (m + s).clamp(-1.0, 1.0);
        let _ = writer.write_sample((mixed * i16::MAX as f32) as i16);
    }
    writer.finalize().map_err(|e| anyhow!("mix finalize: {}", e))?;

    eprintln!("[audio/mixed] mixed WAV written to {:?}", out);
    Ok(())
}

/// « Terminer » (spec/03) : arrête la capture et passe la prise en revue
/// « prise terminée » (`status = 'stopped'`). **Ne lance plus l'aval** — c'est
/// `process_recording` (bouton Continuer) qui enfile les traitements cochés.
pub async fn stop_recording(
    data_dir: &PathBuf,
    active_recording_id: Arc<StdMutex<Option<String>>>,
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    recording_handle: Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    db: SqlitePool,
    app_handle: tauri::AppHandle,
) -> Result<String> {
    let recording_id = active_recording_id
        .lock().unwrap().take()
        .ok_or_else(|| anyhow!("No active recording"))?;

    // Signal the recording thread(s) to stop (a paused take stops fine too)
    pause_flag.store(false, Ordering::SeqCst);
    stop_flag.store(true, Ordering::SeqCst);

    // Wait for the recording task to finish writing the WAV
    if let Some(handle) = recording_handle.lock().await.take() {
        let _ = handle.await;
    }

    eprintln!("[audio] recording task finished");

    let file_path = data_dir.join("recordings").join(format!("{}.wav", recording_id));
    if !file_path.exists() {
        return Err(anyhow!("WAV file not found after recording: {:?}", file_path));
    }

    sqlx::query!(
        "UPDATE recordings SET status = 'stopped' WHERE id = ?",
        recording_id
    )
    .execute(&db)
    .await?;

    let purpose: Option<String> = sqlx::query_scalar("SELECT purpose FROM recordings WHERE id = ?")
        .bind(&recording_id)
        .fetch_optional(&db)
        .await
        .ok()
        .flatten();
    app_handle.emit("recording-status-changed", serde_json::json!({
        "status": "stopped",
        "duration_seconds": 0,
        "recording_id": recording_id,
        "purpose": purpose.unwrap_or_else(|| "meeting".to_string()),
    }))?;

    Ok(recording_id)
}

/// Bouton « Annuler » pendant la prise (spec/03) : arrête la capture, **jette le
/// WAV** et supprime la ligne DB — aucun traitement aval. Retour à l'état idle.
pub async fn cancel_recording(
    data_dir: &PathBuf,
    active_recording_id: Arc<StdMutex<Option<String>>>,
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    recording_handle: Arc<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    db: SqlitePool,
    app_handle: tauri::AppHandle,
) -> Result<()> {
    let recording_id = active_recording_id
        .lock().unwrap().take()
        .ok_or_else(|| anyhow!("No active recording"))?;

    pause_flag.store(false, Ordering::SeqCst);
    stop_flag.store(true, Ordering::SeqCst);
    if let Some(handle) = recording_handle.lock().await.take() {
        let _ = handle.await;
    }

    discard_recording_files(data_dir, &recording_id, &db).await?;

    app_handle.emit("recording-status-changed", serde_json::json!({
        "status": "idle",
        "duration_seconds": 0
    }))?;
    eprintln!("[audio] recording {} cancelled — WAV discarded", recording_id);
    Ok(())
}

/// Supprime le WAV (encore dans `$APP_DATA_DIR/recordings/`) et la ligne
/// `recordings`. Partagé par `cancel_recording` (Annuler pendant la prise) et la
/// commande `discard_recording` (Supprimer / Recommencer depuis la revue).
pub async fn discard_recording_files(
    data_dir: &PathBuf,
    recording_id: &str,
    db: &SqlitePool,
) -> Result<()> {
    let file_path = data_dir.join("recordings").join(format!("{}.wav", recording_id));
    if file_path.exists() {
        let _ = tokio::fs::remove_file(&file_path).await;
    }
    // Temp captures of the `mixed` mode, if the stop happened mid-mix.
    for ext in ["mic.wav", "sys.wav"] {
        let p = file_path.with_extension(ext);
        if p.exists() {
            let _ = tokio::fs::remove_file(&p).await;
        }
    }
    sqlx::query!("DELETE FROM recordings WHERE id = ?", recording_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Capture micro « clip » pour la dictée éphémère (spec/07b) : aucun événement
/// `recording-status-changed`, pas de pause — juste un WAV temporaire jusqu'au
/// stop. L'état est porté par `dictation-status-changed` côté commande.
pub fn record_dictation_clip(file_path: PathBuf, stop_flag: Arc<AtomicBool>) -> Result<()> {
    let no_pause = Arc::new(AtomicBool::new(false));
    record_microphone(file_path, stop_flag, no_pause, None)
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
