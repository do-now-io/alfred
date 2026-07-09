//! Transcription live par chunks (spec/16).
//!
//! Une `LiveSession` est la source de vérité et l'unique écrivain du fichier
//! note pendant l'enregistrement. Trois acteurs :
//! - le **chunker** (thread std) : reçoit les samples mono du tap audio
//!   (spec/03), coupe sur les silences (8–30 s), resample à 16 kHz ;
//! - le **thread Whisper** (std) : contexte chargé une seule fois, transcrit
//!   chaque chunk avec l'`initial_prompt` du chunk précédent ;
//! - l'**acteur** (tâche tokio) : corps autoritaire de la note, écritures
//!   fichier, réconciliation des saves éditeur (`last_seq`), finalisation.
//!
//! Les éditions utilisateur gagnent toujours : voir `ActorMsg::UserSave`.

use anyhow::{anyhow, Result};
use serde::Serialize;
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Emitter;
use ts_rs::TS;

use crate::notes::{frontmatter, NoteMetadata};
use super::WhisperSegment;

// ─── Découpage (spec/16) ───────────────────────────────────────────────────────

const MIN_CHUNK_SECS: f64 = 8.0;
const MAX_CHUNK_SECS: f64 = 30.0;
const SILENCE_RMS: f32 = 0.010;
const SILENCE_MIN_MS: u64 = 700;
/// Fin du texte du chunk précédent passée en `initial_prompt` à Whisper.
const INITIAL_PROMPT_TAIL_CHARS: usize = 200;
/// Garde-fou si le moteur ne signale jamais sa fin après un stop.
const FINALIZE_ENGINE_TIMEOUT_SECS: u64 = 300;

// ─── Messages ─────────────────────────────────────────────────────────────────

/// Envoyé depuis le callback cpal (spec/03 "tap") — ne bloque jamais.
pub enum TapMsg {
    /// Sample rate natif du device, envoyé avant les premiers samples.
    Format(u32),
    /// Samples mono f32 au rate natif (déjà downmixés par `write_frames`).
    Samples(Vec<f32>),
}

struct ChunkAudio {
    samples_16k: Vec<f32>,
    start_sec: f64,
    end_sec: f64,
}

enum ActorMsg {
    Chunk {
        text: String,
        start_sec: f64,
        end_sec: f64,
        segments: Vec<WhisperSegment>,
        language: Option<String>,
    },
    /// Le thread Whisper a fini de drainer (tap fermé + file vide).
    EngineDone,
    UserSave {
        metadata: NoteMetadata,
        body: String,
        last_seq: u32,
        reply: tokio::sync::oneshot::Sender<Result<crate::notes::NoteFile>>,
    },
    Snapshot {
        reply: tokio::sync::oneshot::Sender<LiveSessionSnapshot>,
    },
    Finalize {
        wav_path: PathBuf,
    },
    /// Le démarrage de la capture a échoué : arrêt sans finalisation.
    Abort,
}

// ─── Événements (ts-rs → src/bindings/) ───────────────────────────────────────

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LiveSessionStarted {
    pub recording_id: String,
    pub note_path: String,
    pub note_title: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LiveChunkEvent {
    pub recording_id: String,
    pub seq: u32,
    pub text: String,
    pub start_sec: f64,
    pub end_sec: f64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LiveSessionSnapshot {
    pub recording_id: String,
    pub note_path: String,
    pub note_title: String,
    pub body: String,
    pub metadata: NoteMetadata,
    pub last_seq: u32,
    pub improving: bool,
}

// ─── Handle ───────────────────────────────────────────────────────────────────

pub type SessionSlot = Arc<tokio::sync::Mutex<Option<LiveSessionHandle>>>;

#[derive(Clone)]
pub struct LiveSessionHandle {
    pub recording_id: String,
    pub note_path: PathBuf,
    pub tap_tx: std::sync::mpsc::Sender<TapMsg>,
    cmd_tx: tokio::sync::mpsc::Sender<ActorMsg>,
}

impl LiveSessionHandle {
    pub async fn user_save(
        &self,
        metadata: NoteMetadata,
        body: String,
        last_seq: u32,
    ) -> Result<crate::notes::NoteFile> {
        let (reply, rx) = tokio::sync::oneshot::channel();
        self.cmd_tx
            .send(ActorMsg::UserSave { metadata, body, last_seq, reply })
            .await
            .map_err(|_| anyhow!("Live session terminée"))?;
        rx.await.map_err(|_| anyhow!("Live session terminée"))?
    }

    pub async fn snapshot(&self) -> Result<LiveSessionSnapshot> {
        let (reply, rx) = tokio::sync::oneshot::channel();
        self.cmd_tx
            .send(ActorMsg::Snapshot { reply })
            .await
            .map_err(|_| anyhow!("Live session terminée"))?;
        rx.await.map_err(|_| anyhow!("Live session terminée"))
    }

    /// Déclenche la finalisation (drain + SQLite + WAV + ingestion) sans
    /// attendre qu'elle se termine — l'acteur émet les événements de fin.
    pub async fn finalize(&self, wav_path: PathBuf) -> Result<()> {
        self.cmd_tx
            .send(ActorMsg::Finalize { wav_path })
            .await
            .map_err(|_| anyhow!("Live session terminée"))
    }

    pub async fn abort(&self) {
        let _ = self.cmd_tx.send(ActorMsg::Abort).await;
    }
}

// ─── Session ──────────────────────────────────────────────────────────────────

struct ChunkRec {
    seq: u32,
    /// Sortie Whisper exacte — la référence du test « l'utilisateur a édité ? ».
    original_text: String,
    /// Texte courant dans le corps (original, ou amélioré à l'étape spec/16
    /// « amélioration Claude »).
    current_text: String,
}

/// Démarre la session : crée la note immédiatement, lance chunker + Whisper +
/// acteur, émet `live-session-started`. Échoue si Whisper n'est pas compilé ou
/// si le modèle est introuvable — l'appelant retombe alors sur le pipeline
/// full-file (spec/04).
pub async fn start_live_session(
    recording_id: String,
    db: SqlitePool,
    app_handle: tauri::AppHandle,
    vault_root: PathBuf,
    data_dir: PathBuf,
    resource_dir: Option<PathBuf>,
    session_slot: SessionSlot,
) -> Result<LiveSessionHandle> {
    if !cfg!(feature = "whisper") {
        return Err(anyhow!("Whisper not compiled"));
    }

    let model_size = sqlx::query_scalar!("SELECT value FROM config WHERE key = 'whisper_model'")
        .fetch_optional(&db)
        .await?
        .unwrap_or_else(|| "small".to_string());
    let model_path = super::resolve_model_path_parts(&model_size, resource_dir.as_ref(), &data_dir)?;

    let lang = sqlx::query_scalar!("SELECT value FROM config WHERE key = 'language_hint'")
        .fetch_optional(&db)
        .await?
        .unwrap_or_else(|| "auto".to_string());
    let language_hint = if lang == "auto" { None } else { Some(lang) };

    // La note naît au start (spec/16) — même titre que le futur WAV.
    let note_title = super::format_note_title();
    let rec_folder = super::recording_folder(&db).await;
    let note = crate::notes::vault::create_recording_note(
        &vault_root.join(&rec_folder),
        &note_title,
        &recording_id,
        "",
    )
    .await?;
    let note_path = PathBuf::from(&note.path);
    // Le titre réel peut différer (suffixe anti-collision " 2") — on suit le fichier.
    let note_title = note_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(note_title);

    let (tap_tx, tap_rx) = std::sync::mpsc::channel::<TapMsg>();
    let (whisper_tx, whisper_rx) = std::sync::mpsc::channel::<ChunkAudio>();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::channel::<ActorMsg>(64);

    std::thread::Builder::new()
        .name("live-chunker".into())
        .spawn(move || run_chunker(tap_rx, whisper_tx))
        .map_err(|e| anyhow!("chunker thread: {}", e))?;

    let actor_tx = cmd_tx.clone();
    let hint = language_hint.clone();
    std::thread::Builder::new()
        .name("live-whisper".into())
        .spawn(move || run_whisper_thread(model_path, hint, whisper_rx, actor_tx))
        .map_err(|e| anyhow!("whisper thread: {}", e))?;

    let session = LiveSession {
        recording_id: recording_id.clone(),
        note_path: note_path.clone(),
        note_title: note_title.clone(),
        metadata: note.metadata,
        body: note.body.trim_end().to_string(),
        chunks: Vec::new(),
        segments: Vec::new(),
        last_seq: 0,
        language: language_hint,
        model_size,
        engine_done: false,
        db,
        app_handle: app_handle.clone(),
        vault_root,
        rec_folder,
        session_slot,
    };
    tauri::async_runtime::spawn(session.run(cmd_rx));

    let started = LiveSessionStarted {
        recording_id: recording_id.clone(),
        note_path: note_path.to_string_lossy().to_string(),
        note_title,
    };
    let _ = app_handle.emit("live-session-started", &started);
    let _ = app_handle.emit("notes-updated", serde_json::json!({}));

    Ok(LiveSessionHandle { recording_id, note_path, tap_tx, cmd_tx })
}

struct LiveSession {
    recording_id: String,
    note_path: PathBuf,
    note_title: String,
    metadata: NoteMetadata,
    /// Corps autoritaire de la note (sans frontmatter).
    body: String,
    chunks: Vec<ChunkRec>,
    /// Segments Whisper rebasés en temps absolu (pour `segments_json`).
    segments: Vec<WhisperSegment>,
    last_seq: u32,
    /// Hint forcé, sinon première détection Whisper.
    language: Option<String>,
    model_size: String,
    engine_done: bool,
    db: SqlitePool,
    app_handle: tauri::AppHandle,
    vault_root: PathBuf,
    rec_folder: String,
    session_slot: SessionSlot,
}

impl LiveSession {
    async fn run(mut self, mut rx: tokio::sync::mpsc::Receiver<ActorMsg>) {
        let mut pending_finalize: Option<PathBuf> = None;

        loop {
            let msg = if pending_finalize.is_some() {
                // On attend la fin du drain moteur, avec garde-fou.
                match tokio::time::timeout(
                    tokio::time::Duration::from_secs(FINALIZE_ENGINE_TIMEOUT_SECS),
                    rx.recv(),
                )
                .await
                {
                    Ok(m) => m,
                    Err(_) => {
                        eprintln!("[live] engine drain timeout — finalizing with what we have");
                        self.engine_done = true;
                        Some(ActorMsg::EngineDone)
                    }
                }
            } else {
                rx.recv().await
            };

            let Some(msg) = msg else { break };

            match msg {
                ActorMsg::Chunk { text, start_sec, end_sec, segments, language } => {
                    self.apply_chunk(text, start_sec, end_sec, segments, language).await;
                }
                ActorMsg::EngineDone => {
                    self.engine_done = true;
                }
                ActorMsg::UserSave { metadata, body, last_seq, reply } => {
                    let result = self.apply_user_save(metadata, body, last_seq).await;
                    let _ = reply.send(result);
                }
                ActorMsg::Snapshot { reply } => {
                    let _ = reply.send(self.snapshot());
                }
                ActorMsg::Finalize { wav_path } => {
                    pending_finalize = Some(wav_path);
                }
                ActorMsg::Abort => {
                    // Démarrage de capture raté : on retire la note vide créée au start.
                    if self.chunks.is_empty() {
                        let _ = tokio::fs::remove_file(&self.note_path).await;
                        let _ = self.app_handle.emit("notes-updated", serde_json::json!({}));
                    }
                    self.clear_slot().await;
                    return;
                }
            }

            if self.engine_done {
                if let Some(wav_path) = pending_finalize.take() {
                    self.finalize(wav_path).await;
                    return;
                }
            }
        }

        // Canal fermé sans finalize (handle perdu) — on libère juste le slot.
        self.clear_slot().await;
    }

    fn snapshot(&self) -> LiveSessionSnapshot {
        LiveSessionSnapshot {
            recording_id: self.recording_id.clone(),
            note_path: self.note_path.to_string_lossy().to_string(),
            note_title: self.note_title.clone(),
            body: self.body.clone(),
            metadata: self.metadata.clone(),
            last_seq: self.last_seq,
            improving: false,
        }
    }

    async fn apply_chunk(
        &mut self,
        text: String,
        start_sec: f64,
        end_sec: f64,
        segments: Vec<WhisperSegment>,
        language: Option<String>,
    ) {
        if self.language.is_none() {
            self.language = language;
        }
        self.segments.extend(segments);

        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }

        self.last_seq += 1;
        let seq = self.last_seq;
        self.body.push_str("\n\n");
        self.body.push_str(&text);
        self.chunks.push(ChunkRec {
            seq,
            original_text: text.clone(),
            current_text: text.clone(),
        });

        self.write_note().await;
        let _ = self.app_handle.emit(
            "live-transcription-chunk",
            &LiveChunkEvent {
                recording_id: self.recording_id.clone(),
                seq,
                text,
                start_sec,
                end_sec,
            },
        );
    }

    /// Save réconcilié (spec/16) : le body de l'éditeur devient le corps
    /// autoritaire, après ré-append des chunks qu'il n'avait pas encore vus
    /// (`seq > last_seq`) — un chunk arrivé pendant le debounce n'est jamais perdu.
    async fn apply_user_save(
        &mut self,
        metadata: NoteMetadata,
        body: String,
        last_seq: u32,
    ) -> Result<crate::notes::NoteFile> {
        let mut body = body.trim_end().to_string();
        for chunk in self.chunks.iter().filter(|c| c.seq > last_seq) {
            body.push_str("\n\n");
            body.push_str(&chunk.current_text);
        }
        self.body = body;
        self.metadata = metadata;
        self.write_note().await;

        Ok(crate::notes::NoteFile {
            path: self.note_path.to_string_lossy().to_string(),
            metadata: self.metadata.clone(),
            body: self.body.clone(),
            word_count: self.body.split_whitespace().count(),
            char_count: self.body.chars().count(),
            prop_count: self.metadata.prop_count(),
        })
    }

    async fn write_note(&self) {
        let content = frontmatter::serialize(&self.metadata, &self.body);
        if let Err(e) = tokio::fs::write(&self.note_path, content).await {
            eprintln!("[live] failed to write note {:?}: {}", self.note_path, e);
        }
    }

    async fn clear_slot(&self) {
        let mut slot = self.session_slot.lock().await;
        // Ne libérer que notre propre session — une nouvelle a pu démarrer.
        if slot.as_ref().map(|h| h.recording_id == self.recording_id).unwrap_or(false) {
            *slot = None;
        }
    }

    /// Fin de session (spec/16) : SQLite, WAV déplacé, `transcription-complete`,
    /// ingestion sur le contenu FINAL de la note (éditions comprises).
    async fn finalize(mut self, wav_path: PathBuf) {
        // raw_text = sorties Whisper originales (sémantique « brut » en base).
        let raw_text = self
            .chunks
            .iter()
            .map(|c| c.original_text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let segments_json = serde_json::to_string(&self.segments).unwrap_or_else(|_| "[]".into());
        let now = chrono::Utc::now().to_rfc3339();
        let transcription_id = uuid::Uuid::new_v4().to_string();

        let insert = sqlx::query!(
            r#"INSERT INTO transcriptions
               (id, recording_id, raw_text, segments_json, language, whisper_model, processed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)"#,
            transcription_id,
            self.recording_id,
            raw_text,
            segments_json,
            self.language,
            self.model_size,
            now
        )
        .execute(&self.db)
        .await;
        if let Err(e) = insert {
            eprintln!("[live] failed to insert transcription: {}", e);
        }

        let _ = sqlx::query!(
            "UPDATE recordings SET status = 'done' WHERE id = ?",
            self.recording_id
        )
        .execute(&self.db)
        .await;

        super::move_wav_to_vault(&wav_path, Some(&self.vault_root), &self.rec_folder, &self.note_title).await;

        // S'assurer que le fichier porte bien le dernier état avant l'ingestion.
        self.write_note().await;

        let _ = self.app_handle.emit(
            "transcription-progress",
            serde_json::json!({ "recording_id": self.recording_id, "percent": 100 }),
        );
        let _ = self.app_handle.emit(
            "transcription-complete",
            serde_json::json!({ "recording_id": self.recording_id, "transcription_id": transcription_id }),
        );
        let _ = self.app_handle.emit(
            "live-session-ended",
            serde_json::json!({ "recording_id": self.recording_id }),
        );

        // Ingestion sur la note finale (précédent : run_ingestion_for_note).
        let note_path = self.note_path.clone();
        let db = self.db.clone();
        let vault = self.vault_root.clone();
        let app = self.app_handle.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) =
                crate::ai::run_ingestion_for_note(&note_path, &db, Some(vault.as_path()), &app).await
            {
                eprintln!("[live] ingestion error: {}", e);
            }
        });

        self.clear_slot().await;
        self.chunks.clear();
    }
}

// ─── Chunker ──────────────────────────────────────────────────────────────────

/// Coupe le flux mono natif en chunks : dès `MIN_CHUNK_SECS`, à la première
/// plage de silence (`SILENCE_RMS` pendant `SILENCE_MIN_MS`) ; coupe forcée à
/// `MAX_CHUNK_SECS`. Les chunks entièrement silencieux ne partent pas à Whisper.
fn run_chunker(tap_rx: std::sync::mpsc::Receiver<TapMsg>, whisper_tx: std::sync::mpsc::Sender<ChunkAudio>) {
    let mut rate: u32 = 0;
    let mut buffer: Vec<f32> = Vec::new();
    let mut consumed: u64 = 0; // samples déjà découpés (base des temps absolus)

    let cut = |buffer: &mut Vec<f32>, consumed: &mut u64, rate: u32| {
        if buffer.is_empty() || rate == 0 {
            return;
        }
        let samples = std::mem::take(buffer);
        let start_sec = *consumed as f64 / rate as f64;
        *consumed += samples.len() as u64;
        let end_sec = *consumed as f64 / rate as f64;

        if !has_audible_content(&samples, rate) {
            return; // silence intégral — rien à transcrire
        }

        let samples_16k = if rate == 16_000 {
            samples
        } else {
            match super::resample(&samples, rate, 16_000) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[live/chunker] resample failed: {}", e);
                    return;
                }
            }
        };
        let _ = whisper_tx.send(ChunkAudio { samples_16k, start_sec, end_sec });
    };

    while let Ok(msg) = tap_rx.recv() {
        match msg {
            TapMsg::Format(r) => rate = r.max(1),
            TapMsg::Samples(mono) => {
                if rate == 0 {
                    continue;
                }
                buffer.extend_from_slice(&mono);
                let dur = buffer.len() as f64 / rate as f64;
                if dur >= MAX_CHUNK_SECS
                    || (dur >= MIN_CHUNK_SECS && trailing_silence(&buffer, rate))
                {
                    cut(&mut buffer, &mut consumed, rate);
                }
            }
        }
    }

    // Tap fermé (capture terminée) : flush du reliquat.
    cut(&mut buffer, &mut consumed, rate);
    // whisper_tx droppé ici → le thread Whisper drainera puis signalera EngineDone.
}

/// RMS d'une fenêtre de samples.
fn rms(window: &[f32]) -> f32 {
    if window.is_empty() {
        return 0.0;
    }
    (window.iter().map(|s| s * s).sum::<f32>() / window.len() as f32).sqrt()
}

/// Les `SILENCE_MIN_MS` dernières millisecondes sont-elles silencieuses ?
fn trailing_silence(buffer: &[f32], rate: u32) -> bool {
    let window = (rate as usize / 10).max(1); // 100 ms
    let needed = (SILENCE_MIN_MS as usize / 100).max(1);
    if buffer.len() < window * needed {
        return false;
    }
    buffer[buffer.len() - window * needed..]
        .chunks(window)
        .all(|w| rms(w) < SILENCE_RMS)
}

/// Au moins une fenêtre de 100 ms au-dessus du seuil ?
fn has_audible_content(samples: &[f32], rate: u32) -> bool {
    let window = (rate as usize / 10).max(1);
    samples.chunks(window).any(|w| rms(w) >= SILENCE_RMS)
}

// ─── Thread Whisper persistant ────────────────────────────────────────────────

#[cfg(feature = "whisper")]
fn run_whisper_thread(
    model_path: PathBuf,
    language_hint: Option<String>,
    rx: std::sync::mpsc::Receiver<ChunkAudio>,
    actor_tx: tokio::sync::mpsc::Sender<ActorMsg>,
) {
    let result = (|| -> Result<()> {
        let ctx = whisper_rs::WhisperContext::new_with_params(
            model_path.to_str().ok_or_else(|| anyhow!("Invalid model path"))?,
            whisper_rs::WhisperContextParameters::default(),
        )
        .map_err(|e| anyhow!("Failed to load Whisper model: {:?}", e))?;
        let mut state = ctx.create_state().map_err(|e| anyhow!("{:?}", e))?;
        eprintln!("[live/whisper] model loaded: {:?}", model_path);

        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(4))
            .unwrap_or(4) as i32;
        let mut prev_tail = String::new();
        let mut detected: Option<String> = None;

        while let Ok(chunk) = rx.recv() {
            let mut params =
                whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
            params.set_print_special(false);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);
            params.set_translate(false);
            params.set_n_threads(threads);
            params.set_language(Some(language_hint.as_deref().unwrap_or("auto")));
            // Cohérence inter-chunks : la fin du chunk précédent guide celui-ci
            // (orthographe des noms propres, ponctuation, casse).
            if !prev_tail.is_empty() {
                params.set_initial_prompt(&prev_tail);
            }

            if let Err(e) = state.full(params, &chunk.samples_16k) {
                eprintln!("[live/whisper] full() failed: {:?}", e);
                continue;
            }

            let num_segments = state.full_n_segments().unwrap_or(0);
            let mut parts = Vec::new();
            let mut segments = Vec::new();
            for i in 0..num_segments {
                let Ok(text) = state.full_get_segment_text(i) else { continue };
                let t0 = state.full_get_segment_t0(i).unwrap_or(0) as f64 / 100.0;
                let t1 = state.full_get_segment_t1(i).unwrap_or(0) as f64 / 100.0;
                parts.push(text.trim().to_string());
                segments.push(WhisperSegment {
                    start: chunk.start_sec + t0,
                    end: chunk.start_sec + t1,
                    text: text.trim().to_string(),
                });
            }
            let text = parts.join(" ");

            if detected.is_none() {
                detected = match language_hint.as_deref() {
                    Some(l) => Some(l.to_string()),
                    None => state
                        .full_lang_id_from_state()
                        .ok()
                        .and_then(whisper_rs::get_lang_str)
                        .map(|s| s.to_string()),
                };
            }

            // Queue du texte pour l'initial_prompt suivant (borne sur des
            // frontières de caractères — accents français).
            prev_tail = tail_chars(&text, INITIAL_PROMPT_TAIL_CHARS);

            let msg = ActorMsg::Chunk {
                text,
                start_sec: chunk.start_sec,
                end_sec: chunk.end_sec,
                segments,
                language: detected.clone(),
            };
            if actor_tx.blocking_send(msg).is_err() {
                break; // acteur parti — plus personne à servir
            }
        }
        Ok(())
    })();

    if let Err(e) = result {
        eprintln!("[live/whisper] engine error: {}", e);
    }
    let _ = actor_tx.blocking_send(ActorMsg::EngineDone);
}

#[cfg(not(feature = "whisper"))]
fn run_whisper_thread(
    _model_path: PathBuf,
    _language_hint: Option<String>,
    _rx: std::sync::mpsc::Receiver<ChunkAudio>,
    actor_tx: tokio::sync::mpsc::Sender<ActorMsg>,
) {
    let _ = actor_tx.blocking_send(ActorMsg::EngineDone);
}

fn tail_chars(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    text.chars().skip(count - max_chars).collect()
}
