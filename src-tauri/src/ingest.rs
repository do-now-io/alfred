//! "Ingest" — runs the local Claude Code CLI headlessly in the vault directory
//! to process `raw/` notes into the structured wiki (via the vault's own
//! CLAUDE.md + `/ingest` skill). Triggered by the Ingest button in the Notes tab.

use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::Emitter;
use tokio::io::AsyncBufReadExt;

/// Default prompt, editable from Settings (config key `ingest_prompt`).
pub const DEFAULT_INGEST_PROMPT: &str = "Applique les directives du CLAUDE.md. Lance la commande /ingest le but étant Structure le compte-rendu avec les points clés abordés. Si tu identifies des tâches, fais-les remonter.";

/// Hard cap so a stuck agent can't hang forever.
const INGEST_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Tools Claude may use during ingestion without a permission prompt.
/// Anything else is auto-denied in non-interactive (`-p`) mode.
const ALLOWED_TOOLS: &str =
    "Read,Edit,Write,Bash(ls *),Bash(find *),Bash(cat *),Bash(head *),Bash(tree *),Bash(mkdir *)";

/// The configured ingest prompt, or the built-in default if none is set.
pub async fn load_prompt(db: &sqlx::SqlitePool) -> String {
    // Same SQL string as `get_config` so it reuses the offline `.sqlx` cache.
    let key = "ingest_prompt";
    let stored: Option<String> = sqlx::query_scalar!("SELECT value FROM config WHERE key = ?", key)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();

    stored
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_INGEST_PROMPT.to_string())
}

/// Locate the `claude` binary. A GUI app launched from Finder gets a minimal
/// PATH, so we probe the usual install locations before falling back to PATH.
fn resolve_claude() -> String {
    let mut candidates: Vec<PathBuf> = vec![];
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(&home).join(".local/bin/claude"));
        candidates.push(PathBuf::from(&home).join(".claude/local/claude"));
        candidates.push(PathBuf::from(&home).join("bin/claude"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    candidates.push(PathBuf::from("/usr/local/bin/claude"));

    candidates
        .into_iter()
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "claude".to_string())
}

/// Emit one log line — both to the dev terminal (eprintln) and to the frontend
/// via the `ingest-log` event so the user can watch progress live.
fn emit_log(app: &tauri::AppHandle, line: impl AsRef<str>) {
    let line = line.as_ref();
    eprintln!("[ingest] {line}");
    let _ = app.emit("ingest-log", line.to_string());
}

/// Run Claude Code headlessly in the vault to ingest `raw/`, streaming its
/// output line-by-line as `ingest-log` events. Returns the collected stdout.
pub async fn run_ingest(prompt: &str, vault_root: &Path, app: &tauri::AppHandle) -> Result<String> {
    if !vault_root.exists() {
        return Err(anyhow!("Le dossier du vault est introuvable : {:?}", vault_root));
    }

    let claude = resolve_claude();
    emit_log(app, format!("$ {claude} -p <prompt> --allowedTools \"{ALLOWED_TOOLS}\" --output-format text --verbose"));
    emit_log(app, format!("Dossier : {}", vault_root.display()));
    emit_log(app, format!("Prompt envoyé : {prompt}"));

    let mut child = tokio::process::Command::new(&claude)
        .arg("-p")
        .arg(prompt)
        .arg("--allowedTools")
        .arg(ALLOWED_TOOLS)
        .arg("--output-format")
        .arg("text")
        .arg("--verbose")
        .current_dir(vault_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            let msg = format!(
                "Impossible de lancer Claude ({claude}) : {e}. Vérifiez que le CLI `claude` est installé."
            );
            emit_log(app, &msg);
            anyhow!(msg)
        })?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let app_out = app.clone();
    let out_task = tokio::spawn(async move {
        let mut collected = String::new();
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            emit_log(&app_out, &line);
            collected.push_str(&line);
            collected.push('\n');
        }
        collected
    });

    let app_err = app.clone();
    let err_task = tokio::spawn(async move {
        let mut collected = String::new();
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            emit_log(&app_err, &line);
            collected.push_str(&line);
            collected.push('\n');
        }
        collected
    });

    let status = match tokio::time::timeout(INGEST_TIMEOUT, child.wait()).await {
        Ok(res) => res.map_err(|e| anyhow!("Erreur d'exécution de Claude : {e}"))?,
        Err(_) => {
            let _ = child.start_kill();
            emit_log(app, "✗ Délai dépassé (15 min) — ingestion interrompue.");
            return Err(anyhow!("L'ingestion a dépassé le délai imparti (15 min) et a été interrompue."));
        }
    };

    let stdout_s = out_task.await.unwrap_or_default();
    let stderr_s = err_task.await.unwrap_or_default();

    if status.success() {
        emit_log(app, "✓ Ingestion terminée.");
        let s = stdout_s.trim().to_string();
        Ok(if s.is_empty() { "Ingestion terminée.".to_string() } else { s })
    } else {
        let code = status.code().unwrap_or(-1);
        emit_log(app, format!("✗ Claude a échoué (code {code})."));
        let detail = if !stderr_s.trim().is_empty() {
            stderr_s.trim().to_string()
        } else {
            stdout_s.trim().to_string()
        };
        Err(anyhow!("Claude a échoué (code {code}). {detail}"))
    }
}
