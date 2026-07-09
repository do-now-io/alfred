//! Contexte interne (spec/16) — a user-written vault note describing the
//! company, the team and the house vocabulary. Injected into the live chunk-fix
//! prompt and the ingestion prompt (spec/05) so Claude can spell proper nouns
//! correctly. The note belongs to the user: created lazily with a template,
//! never overwritten.

use anyhow::Result;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};

pub const DEFAULT_CONTEXT_NOTE: &str = "Contexte Alfred.md";

/// Injecting an unbounded note would blow up every chunk-fix call; 4 000 chars
/// of context is plenty to cover names/teams/vocabulary (spec/16).
const MAX_CONTEXT_CHARS: usize = 4_000;

const CONTEXT_TEMPLATE: &str = r#"# Contexte Alfred

Décris ici ton environnement de travail : Alfred s'en sert pour corriger les
noms propres et le vocabulaire dans les transcriptions et les comptes-rendus.

## Mon entreprise

## Équipe (prénoms & rôles)

## Vocabulaire maison & noms propres

## Projets en cours
"#;

/// Vault-relative path of the context note (config `context_note_path`,
/// default in code — same pattern as `recording_folder`).
pub async fn context_note_path(db: &SqlitePool) -> String {
    let stored: Option<String> =
        sqlx::query_scalar("SELECT value FROM config WHERE key = 'context_note_path'")
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    stored
        .map(|s| s.trim().trim_matches('/').trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_CONTEXT_NOTE.to_string())
}

/// Lazily create the context note with its template. Never overwrites.
pub async fn ensure_context_note(vault_root: &Path, db: &SqlitePool) -> Result<PathBuf> {
    let path = vault_root.join(context_note_path(db).await);
    if !path.exists() {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let metadata = super::NoteMetadata::new("Contexte Alfred");
        let content = super::frontmatter::serialize(&metadata, CONTEXT_TEMPLATE);
        tokio::fs::write(&path, content).await?;
    }
    Ok(path)
}

/// The context body to inject into prompts: frontmatter stripped, capped at
/// `MAX_CONTEXT_CHARS`. `None` if the note is absent or effectively empty
/// (untouched template counts as content — headings alone are harmless).
pub async fn read_context(vault_root: &Path, db: &SqlitePool) -> Option<String> {
    let path = vault_root.join(context_note_path(db).await);
    let raw = tokio::fs::read_to_string(&path).await.ok()?;
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let (_, body) = super::frontmatter::parse(&raw, &stem);
    let body = body.trim();
    if body.is_empty() {
        return None;
    }
    Some(body.chars().take(MAX_CONTEXT_CHARS).collect())
}
