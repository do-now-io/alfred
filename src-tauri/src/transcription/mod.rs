use anyhow::{anyhow, Result};
use chrono::Timelike;
use chrono::Datelike;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::mpsc;
use uuid::Uuid;

/// Émet `transcription-progress { recording_id, percent }` (spec/04, feedback
/// tests) — débounce **sur changement d'entier** (0..100), pas sur un minuteur :
/// suffisant vu la cadence des callbacks whisper.cpp, et sans risque de rater un
/// palier sous charge. Clonable : partagé par les workers de tranches (spec/17 §5).
#[derive(Clone)]
struct ProgressEmitter {
    app_handle: tauri::AppHandle,
    recording_id: String,
    last: Arc<AtomicI32>,
}

impl ProgressEmitter {
    fn new(app_handle: tauri::AppHandle, recording_id: String) -> Self {
        Self { app_handle, recording_id, last: Arc::new(AtomicI32::new(-1)) }
    }

    fn emit(&self, percent: i32) {
        let percent = percent.clamp(0, 100);
        if self.last.swap(percent, Ordering::Relaxed) != percent {
            let _ = self.app_handle.emit("transcription-progress", serde_json::json!({
                "recording_id": self.recording_id,
                "percent": percent
            }));
        }
    }
}

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
    /// Traitements aval cochés au panneau de revue (spec/03/05) : compte-rendu
    /// et/ou tâches. Les deux à `false` → transcription seule, aucun appel IA.
    pub summary: bool,
    pub tasks: bool,
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
    summary: bool,
    tasks: bool,
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
        summary,
        tasks,
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
        let model_size = job.model_size.clone();
        if let Err(e) = process_job(job).await {
            eprintln!("Transcription error: {}", e);
            // Message tronqué par prudence (anonyme, spec/15 §D) — les erreurs
            // observées ici sont de courts messages internes whisper.cpp, mais
            // on borne quand même la taille au cas où.
            let msg: String = e.to_string().chars().take(200).collect();
            crate::metrics::send(
                "transcription_failed",
                serde_json::json!({ "model": model_size, "error": msg }),
            );
        }
    }
}

/// Look for the model in (priority order):
/// 1. Alfred.app/Contents/Resources/models/  — bundled at build time
/// 2. $APP_DATA_DIR/models/                  — downloaded by the user
fn resolve_model_path(job: &TranscriptionJob) -> Result<PathBuf> {
    resolve_model_path_parts(&job.model_size, &job.data_dir, job.resource_dir.as_deref())
}

fn resolve_model_path_parts(model_size: &str, data_dir: &std::path::Path, resource_dir: Option<&std::path::Path>) -> Result<PathBuf> {
    let filename = format!("ggml-{}.bin", model_size);

    if let Some(res_dir) = resource_dir {
        let bundled = res_dir.join("models").join(&filename);
        if bundled.exists() {
            return Ok(bundled);
        }
    }

    let user_path = data_dir.join("models").join(&filename);
    if user_path.exists() {
        return Ok(user_path);
    }

    Err(anyhow!(
        "Model '{}' not found. Bundle it in the app or download it from Settings.",
        filename
    ))
}

/// Transcription légère « clip → texte » pour la dictée éphémère (spec/07b) :
/// mêmes réglages de décodage que le pipeline normal (modèle, langue, threads,
/// glossaire spec/17), mais AUCUNE écriture — ni note, ni ligne `recordings`,
/// ni ingestion. Le WAV appartient à l'appelant (qui le supprime après).
pub async fn transcribe_wav_text(
    wav_path: &std::path::Path,
    db: &SqlitePool,
    data_dir: &std::path::Path,
    resource_dir: Option<&std::path::Path>,
) -> Result<String> {
    let model = sqlx::query_scalar!("SELECT value FROM config WHERE key = 'whisper_model'")
        .fetch_optional(db).await?
        .unwrap_or_else(|| "small".to_string());
    let lang = sqlx::query_scalar!("SELECT value FROM config WHERE key = 'language_hint'")
        .fetch_optional(db).await?
        .unwrap_or_else(|| "auto".to_string());
    let threads = sqlx::query_scalar!("SELECT value FROM config WHERE key = 'whisper_threads'")
        .fetch_optional(db).await?
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|&t| t > 0);
    let glossary = sqlx::query_scalar!("SELECT value FROM config WHERE key = 'transcription_glossary'")
        .fetch_optional(db).await?
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let model_path = resolve_model_path_parts(&model, data_dir, resource_dir)?;
    let wav = wav_path.to_path_buf();
    let language = if lang == "auto" { None } else { Some(lang) };

    let (text, _segments, _detected) = tokio::task::spawn_blocking(move || {
        // Dictée éphémère (spec/07b) : pas de recording_id, pas d'UI à mettre à
        // jour pendant la capture — aucune émission de progression nécessaire.
        run_whisper(&wav, &model_path, language.as_deref(), threads, glossary.as_deref(), None)
    })
    .await??;
    Ok(text.trim().to_string())
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
    let progress = ProgressEmitter::new(job.app_handle.clone(), recording_id.clone());

    // Run Whisper inference in a blocking thread (CPU-bound)
    let decode_started = std::time::Instant::now();
    let (raw_text, segments, detected_language) = tokio::task::spawn_blocking(move || {
        run_whisper(
            &file_path,
            &model_path_clone,
            language.as_deref(),
            threads,
            initial_prompt.as_deref(),
            Some(progress),
        )
    })
    .await??;
    let decode_ms = decode_started.elapsed().as_millis() as u64;

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
    let mut note_path: Option<String> = None;
    if let Some(ref vault_root) = job.vault_path {
        match crate::notes::vault::create_recording_note(
            &vault_root.join(&rec_folder),
            &note_title,
            &recording_id,
            raw_text.trim(),
        ).await {
            Ok(_) => {
                eprintln!("[transcription] vault note created: {}", note_title);
                note_path = Some(
                    vault_root
                        .join(&rec_folder)
                        .join(format!("{}.md", note_title))
                        .to_string_lossy()
                        .to_string(),
                );
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

    // `note_title`/`note_path` let the UI target "where Alfred works" (spec/10)
    // and re-listen to the WAV (moved next to the note) without extra lookups.
    job.app_handle.emit("transcription-complete", serde_json::json!({
        "recording_id": recording_id,
        "transcription_id": transcription_id,
        "note_title": note_title,
        "note_path": note_path,
        "purpose": job.purpose,
    }))?;

    crate::metrics::send(
        "transcription_completed",
        serde_json::json!({ "model": model_size, "duration_ms": decode_ms, "purpose": job.purpose }),
    );

    // Route the downstream by recording purpose (spec/13):
    //  - "context" → build `Contexte Alfred.md` + glossaire (no compte-rendu).
    //  - "meeting" (default) → the merged ingestion, limited to the sections
    //    checked in the review panel (spec/03/05). Nothing checked → no AI call;
    //    `ingestion-status-changed done` is still emitted so the UI settles.
    let db_clone = job.db.clone();
    let app_clone = job.app_handle.clone();
    let vault_clone = job.vault_path.clone();
    let rec_id = recording_id.clone();
    let text = raw_text.clone();
    let title = note_title.clone();
    let purpose = job.purpose.clone();
    let (summary, tasks) = (job.summary, job.tasks);
    tauri::async_runtime::spawn(async move {
        if purpose == "context" {
            if let Err(e) = crate::ai::build_context_from_transcription(&rec_id, &text, Some(&title), &db_clone, vault_clone.as_deref(), &app_clone).await {
                eprintln!("Context build error: {}", e);
            }
        } else if !summary && !tasks {
            let _ = app_clone.emit(
                "ingestion-status-changed",
                serde_json::json!({ "status": "done", "phase": "done", "recording_id": rec_id, "message": null }),
            );
        } else if let Err(e) = crate::ai::run_ingestion_for_recording(&rec_id, &text, &title, summary, tasks, &db_clone, vault_clone.as_deref(), &app_clone).await {
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
/// Default thread cap when config `whisper_threads` is unset. Raised from 4 to 8
/// (spec/17 §2 — beam is CPU-heavy; whisper.cpp scales well up to ~physical
/// cores). Overridable higher via `whisper_threads` for many-core machines.
const DEFAULT_THREADS: usize = 8;

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
    progress: Option<ProgressEmitter>,
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
        // Load the model once — its weights are shared read-only across all
        // decoding states, including the parallel chunk workers below.
        let ctx = whisper_rs::WhisperContext::new_with_params(
            model_path.to_str().ok_or_else(|| anyhow!("Invalid model path"))?,
            whisper_rs::WhisperContextParameters::default(),
        )
        .map_err(|e| anyhow!("Failed to load Whisper model: {:?}", e))?;

        let secs = samples_16k.len() as f64 / SAMPLE_RATE as f64;

        // Short recordings → single pass (best quality, no chunk-seam risk).
        if secs <= CHUNK_MIN_TOTAL_SECS {
            let n_threads = threads.filter(|&t| t > 0).unwrap_or_else(|| {
                std::thread::available_parallelism()
                    .map(|c| c.get())
                    .unwrap_or(DEFAULT_THREADS)
                    .min(DEFAULT_THREADS)
            });
            let cb = progress.map(|p| Box::new(move |pct: i32| p.emit(pct)) as Box<dyn FnMut(i32)>);
            let (segments, detected) = decode_buffer(&ctx, &samples_16k, language, n_threads, initial_prompt, cb)?;
            let text = segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
            return Ok((text, segments, detected));
        }

        // Long recordings → split at silences and transcribe chunks in parallel
        // (spec/17 §5). The model is shared; each worker owns its own state. The
        // glossary is re-injected per chunk, so proper-noun priming never fades
        // on long files. Chunk timestamps are offset back to absolute time.
        let ranges = chunk_ranges(&samples_16k);
        let cores = std::thread::available_parallelism().map(|c| c.get()).unwrap_or(DEFAULT_THREADS);
        // Total thread budget: `whisper_threads` if set, else all logical cores.
        let total = threads.filter(|&t| t > 0).unwrap_or(cores);
        let n_workers = ranges.len().min(((cores + 1) / 2).clamp(1, 6));
        let threads_per = (total / n_workers).clamp(1, 8);
        eprintln!(
            "[transcription] {:.0}s → {} tranches, {} workers × {} threads",
            secs, ranges.len(), n_workers, threads_per
        );

        // Progression agrégée pondérée par tranche (spec/04/17 §5) : chaque
        // worker rapporte sa progression LOCALE (0..100 du `decode_buffer` de sa
        // tranche) dans `chunk_percents[i]` ; le % global recomposé est la somme
        // pondérée par la durée relative de chaque tranche.
        let total_len = samples_16k.len().max(1) as f64;
        let chunk_percents: Arc<Vec<AtomicI32>> = Arc::new((0..ranges.len()).map(|_| AtomicI32::new(0)).collect());
        let chunk_weights: Arc<Vec<f64>> = Arc::new(
            ranges.iter().map(|(a, b)| (*b - *a) as f64 / total_len).collect(),
        );

        let results: Vec<std::sync::Mutex<Option<Result<(Vec<WhisperSegment>, Option<String>)>>>> =
            (0..ranges.len()).map(|_| std::sync::Mutex::new(None)).collect();
        let next = std::sync::atomic::AtomicUsize::new(0);
        // Références simples (Copy) vers les données partagées entre workers —
        // `thread::scope` garantit qu'elles survivent à tous les threads
        // spawnés ; ne les nomme PAS pareil que la valeur possédée pour que
        // `move` ci-dessous ne capture que ces références, pas les originaux.
        let ctx_ref = &ctx;
        let samples_ref = &samples_16k;
        let ranges_ref = &ranges;
        let next_ref = &next;
        let results_ref = &results;
        std::thread::scope(|scope| {
            for _ in 0..n_workers {
                let progress = progress.clone();
                let chunk_percents = chunk_percents.clone();
                let chunk_weights = chunk_weights.clone();
                scope.spawn(move || {
                    loop {
                        let i = next_ref.fetch_add(1, Ordering::SeqCst);
                        if i >= ranges_ref.len() {
                            break;
                        }
                        let (a, b) = ranges_ref[i];
                        let cb: Option<Box<dyn FnMut(i32)>> = progress.clone().map(|p| {
                            let percents = chunk_percents.clone();
                            let weights = chunk_weights.clone();
                            Box::new(move |pct: i32| {
                                percents[i].store(pct, Ordering::Relaxed);
                                let global: f64 = percents.iter().zip(weights.iter())
                                    .map(|(ap, w)| ap.load(Ordering::Relaxed) as f64 * w)
                                    .sum();
                                p.emit(global.round() as i32);
                            }) as Box<dyn FnMut(i32)>
                        });
                        let r = decode_buffer(ctx_ref, &samples_ref[a..b], language, threads_per, initial_prompt, cb);
                        *results_ref[i].lock().unwrap() = Some(r);
                    }
                });
            }
        });

        // Merge chunks in order, offsetting each chunk's timestamps to absolute.
        // A failed chunk is logged and skipped rather than sinking the whole file.
        let mut all_segments: Vec<WhisperSegment> = Vec::new();
        let mut raw_parts: Vec<String> = Vec::new();
        let mut detected: Option<String> = None;
        for (i, (a, _)) in ranges.iter().enumerate() {
            let offset = *a as f64 / SAMPLE_RATE as f64;
            match results[i].lock().unwrap().take() {
                Some(Ok((segs, lang))) => {
                    if detected.is_none() {
                        detected = lang;
                    }
                    for mut s in segs {
                        s.start += offset;
                        s.end += offset;
                        raw_parts.push(s.text.clone());
                        all_segments.push(s);
                    }
                }
                Some(Err(e)) => eprintln!("[transcription] tranche {} échouée: {}", i, e),
                None => {}
            }
        }
        if all_segments.is_empty() {
            return Err(anyhow!("La transcription par tranches a échoué sur toutes les tranches"));
        }
        return Ok((raw_parts.join(" "), all_segments, detected));
    }

    // Stub when whisper feature is disabled
    #[allow(unreachable_code)]
    {
        let _ = (samples_16k, model_path, language, threads, initial_prompt, progress);
        Err(anyhow!(
            "Whisper not compiled. Enable the 'whisper' feature or download a model."
        ))
    }
}

// ─── Parallel chunked decoding (spec/17 §5) ──────────────────────────────────────

#[cfg(feature = "whisper")]
const SAMPLE_RATE: usize = 16_000;
/// Only split recordings longer than this — short ones stay single-pass (best
/// quality, no seam risk).
#[cfg(feature = "whisper")]
const CHUNK_MIN_TOTAL_SECS: f64 = 900.0; // 15 min
/// Target chunk length: long enough to keep decoding context, short enough to
/// fill the worker pool.
#[cfg(feature = "whisper")]
const CHUNK_TARGET_SECS: f64 = 480.0; // 8 min
/// How far each side of a target boundary we hunt for a silence to split on.
#[cfg(feature = "whisper")]
const CHUNK_SEARCH_SECS: f64 = 30.0;

/// Decode one 16 kHz mono buffer → (segments with buffer-local timestamps,
/// detected language). Shared by the single-pass and per-chunk paths. Applies the
/// beam + anti-hallucination + glossary settings (spec/17 §2/§1).
#[cfg(feature = "whisper")]
fn decode_buffer(
    ctx: &whisper_rs::WhisperContext,
    samples: &[f32],
    language: Option<&str>,
    threads: usize,
    initial_prompt: Option<&str>,
    on_progress: Option<Box<dyn FnMut(i32)>>,
) -> Result<(Vec<WhisperSegment>, Option<String>)> {
    let mut params = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::BeamSearch {
        beam_size: BEAM_SIZE,
        patience: BEAM_PATIENCE,
    });
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_translate(false);
    params.set_n_threads(threads.max(1) as i32);
    params.set_no_speech_thold(NO_SPEECH_THOLD);
    params.set_entropy_thold(ENTROPY_THOLD);
    params.set_logprob_thold(LOGPROB_THOLD);
    params.set_temperature(TEMPERATURE);
    params.set_temperature_inc(TEMPERATURE_INC);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    if let Some(prompt) = initial_prompt.map(str::trim).filter(|p| !p.is_empty()) {
        params.set_initial_prompt(prompt);
    }
    // No forced language → "auto" so whisper.cpp detects it (else it defaults to en).
    params.set_language(Some(language.unwrap_or("auto")));
    // Progression réelle (spec/04, feedback tests) — whisper.cpp appelle ce
    // callback régulièrement pendant le décodage avec le % d'avancement DE CET
    // APPEL (une tranche ou tout le fichier en passe unique). Note : whisper-rs
    // « fuit » volontairement la closure boxée (pas de hook de libération côté
    // FFI) — négligeable ici (quelques dizaines d'octets par transcription, v1
    // ~10 utilisateurs).
    if let Some(mut cb) = on_progress {
        params.set_progress_callback_safe(move |p: i32| cb(p));
    }

    let mut state = ctx.create_state().map_err(|e| anyhow!("{:?}", e))?;
    state.full(params, samples).map_err(|e| anyhow!("{:?}", e))?;

    let num = state.full_n_segments().map_err(|e| anyhow!("{:?}", e))?;
    let mut segs = Vec::with_capacity(num as usize);
    for i in 0..num {
        let text = state.full_get_segment_text(i).map_err(|e| anyhow!("{:?}", e))?;
        let t0 = state.full_get_segment_t0(i).map_err(|e| anyhow!("{:?}", e))? as f64 / 100.0;
        let t1 = state.full_get_segment_t1(i).map_err(|e| anyhow!("{:?}", e))? as f64 / 100.0;
        segs.push(WhisperSegment { start: t0, end: t1, text: text.trim().to_string() });
    }
    let detected = match language {
        Some(l) if l != "auto" => Some(l.to_string()),
        _ => state
            .full_lang_id_from_state()
            .ok()
            .and_then(whisper_rs::get_lang_str)
            .map(|s| s.to_string()),
    };
    Ok((segs, detected))
}

/// Sample-index ranges splitting `samples` into ~`CHUNK_TARGET_SECS` chunks, each
/// boundary nudged to the quietest point within ±`CHUNK_SEARCH_SECS` so we don't
/// cut mid-word (spec/17 §5).
#[cfg(feature = "whisper")]
fn chunk_ranges(samples: &[f32]) -> Vec<(usize, usize)> {
    let len = samples.len();
    let target = (CHUNK_TARGET_SECS * SAMPLE_RATE as f64) as usize;
    let search = (CHUNK_SEARCH_SECS * SAMPLE_RATE as f64) as usize;
    let mut ranges = Vec::new();
    let mut start = 0usize;
    while len - start > target + search {
        let ideal = start + target;
        let lo = ideal.saturating_sub(search).max(start + 1);
        let hi = (ideal + search).min(len);
        let split = quietest_split(samples, lo, hi).clamp(start + 1, len);
        if split <= start {
            break;
        }
        ranges.push((start, split));
        start = split;
    }
    ranges.push((start, len));
    ranges
}

/// Center index of the lowest-energy ~25 ms frame in `[lo, hi)` — a coarse silence
/// finder for chunk boundaries.
#[cfg(feature = "whisper")]
fn quietest_split(samples: &[f32], lo: usize, hi: usize) -> usize {
    let frame = SAMPLE_RATE / 40; // 25 ms
    if hi <= lo + frame {
        return (lo + hi) / 2;
    }
    let mut best = (lo + hi) / 2;
    let mut best_energy = f32::MAX;
    let mut p = lo;
    while p + frame <= hi {
        let e: f32 = samples[p..p + frame].iter().map(|s| s * s).sum();
        if e < best_energy {
            best_energy = e;
            best = p + frame / 2;
        }
        p += frame;
    }
    best
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

#[cfg(all(test, feature = "whisper"))]
mod chunk_tests {
    use super::*;

    #[test]
    fn short_buffer_is_a_single_range() {
        // 5 min < CHUNK_TARGET: one range spanning the whole buffer.
        let samples = vec![0.0f32; 5 * 60 * SAMPLE_RATE];
        let r = chunk_ranges(&samples);
        assert_eq!(r, vec![(0, samples.len())]);
    }

    #[test]
    fn long_buffer_splits_and_covers_contiguously() {
        // 30 min → several chunks; ranges must tile [0, len) with no gap/overlap.
        let len = 30 * 60 * SAMPLE_RATE;
        let samples = vec![0.1f32; len];
        let r = chunk_ranges(&samples);
        assert!(r.len() >= 3, "expected multiple chunks, got {}", r.len());
        assert_eq!(r[0].0, 0);
        assert_eq!(r.last().unwrap().1, len);
        for w in r.windows(2) {
            assert_eq!(w[0].1, w[1].0, "ranges must be contiguous");
            assert!(w[0].0 < w[0].1, "ranges must be non-empty");
        }
    }

    #[test]
    fn split_prefers_the_quietest_frame() {
        // A loud buffer with a silent gap inside the search window → split lands in it.
        let mut samples = vec![0.5f32; 40 * SAMPLE_RATE];
        let gap_start = 8 * SAMPLE_RATE; // within ±30s of the 8-min target? no — small test
        for s in &mut samples[gap_start..gap_start + SAMPLE_RATE] {
            *s = 0.0;
        }
        let split = quietest_split(&samples, 7 * SAMPLE_RATE, 10 * SAMPLE_RATE);
        assert!(
            split >= gap_start && split < gap_start + SAMPLE_RATE,
            "split {} should fall inside the silent gap [{}, {})",
            split, gap_start, gap_start + SAMPLE_RATE
        );
    }
}
