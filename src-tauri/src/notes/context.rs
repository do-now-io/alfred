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

/// Heading under which post-ingestion learned facts are auto-written (spec/17 §4).
const LEARNED_HEADING: &str = "## Appris automatiquement";

/// Does the context note carry real user/AI content beyond the empty template?
/// Headings, blank lines and EVERY line of the template (intro paragraph
/// included) don't count — the untouched template must never take the append
/// path (spec/16 bug « blocs vides » : l'intro fait deux lignes, filtrer sur
/// « Décris ici » ne couvrait que la première).
fn context_has_content(body: &str) -> bool {
    let template_lines: std::collections::HashSet<&str> = CONTEXT_TEMPLATE
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    body.lines().any(|l| {
        let t = l.trim();
        !t.is_empty() && !t.starts_with('#') && !template_lines.contains(t)
    })
}

/// Write the spoken-onboarding context (spec/13). If the note is still the empty
/// template, replace its body with the structured version. If it already has
/// content, never clobber it — append the structured body under a dated
/// `## Appris à l'oral (date)` heading instead. Frontmatter is preserved.
pub async fn write_spoken_context(vault_root: &Path, db: &SqlitePool, structured_body: &str) -> Result<()> {
    let path = ensure_context_note(vault_root, db).await?;
    let raw = tokio::fs::read_to_string(&path).await?;
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let (metadata, body) = super::frontmatter::parse(&raw, &stem);

    let new_body = if context_has_content(&body) {
        let date = chrono::Local::now().format("%Y-%m-%d");
        // Drop the leading "# Contexte Alfred" title from the structured body when
        // appending, keep just the sections.
        let sections = structured_body
            .lines()
            .skip_while(|l| l.trim().starts_with("# ") || l.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        format!("{}\n\n## Appris à l'oral ({})\n\n{}\n", body.trim_end(), date, sections.trim())
    } else {
        format!("{}\n", structured_body.trim())
    };

    let content = super::frontmatter::serialize(&metadata, &new_body);
    tokio::fs::write(&path, content).await?;
    Ok(())
}

/// Append `facts` (learned during ingestion, spec/17 §4) under the
/// `## Appris automatiquement` section of the context note — created lazily,
/// non-blocking, re-readable/correctable by the user. Deduped against existing
/// bullet lines (case-insensitive, trimmed). Returns the number actually added.
/// The section is auto-managed, but the user owns the note, so we only touch
/// that section and leave everything else untouched.
pub async fn append_learned_facts(
    vault_root: &Path,
    db: &SqlitePool,
    facts: &[String],
) -> Result<usize> {
    let clean: Vec<String> = facts
        .iter()
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .collect();
    if clean.is_empty() {
        return Ok(0);
    }

    let path = ensure_context_note(vault_root, db).await?;
    let raw = tokio::fs::read_to_string(&path).await?;
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let (metadata, body) = super::frontmatter::parse(&raw, &stem);

    // Existing bullets anywhere in the note → dedup set (a fact already written by
    // hand or in a past run must not be duplicated).
    let existing: std::collections::HashSet<String> = body
        .lines()
        .filter_map(|l| l.trim().strip_prefix("- "))
        .map(|l| l.trim().to_lowercase())
        .collect();

    let to_add: Vec<&String> = clean
        .iter()
        .filter(|f| !existing.contains(&f.to_lowercase()))
        .collect();
    if to_add.is_empty() {
        return Ok(0);
    }

    let mut new_body = body.trim_end().to_string();
    if body.contains(LEARNED_HEADING) {
        // Append right after the existing section's last bullet. Simplest robust
        // approach: rebuild by inserting the new bullets just after the heading.
        let mut out = String::new();
        let mut inserted = false;
        for line in new_body.lines() {
            out.push_str(line);
            out.push('\n');
            if !inserted && line.trim() == LEARNED_HEADING {
                for f in &to_add {
                    out.push_str(&format!("- {}\n", f));
                }
                inserted = true;
            }
        }
        new_body = out.trim_end().to_string();
    } else {
        new_body.push_str(&format!("\n\n{}\n", LEARNED_HEADING));
        for f in &to_add {
            new_body.push_str(&format!("- {}\n", f));
        }
        new_body = new_body.trim_end().to_string();
    }

    let content = super::frontmatter::serialize(&metadata, &format!("{}\n", new_body));
    tokio::fs::write(&path, content).await?;
    Ok(to_add.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untouched_template_has_no_content() {
        // The full template — intro paragraph (2 lines!) + empty headings —
        // must NOT count as user content (spec/16 bug « blocs vides »).
        assert!(!context_has_content(CONTEXT_TEMPLATE));
    }

    #[test]
    fn empty_or_headings_only_has_no_content() {
        assert!(!context_has_content(""));
        assert!(!context_has_content("# Contexte Alfred\n\n## Mon entreprise\n"));
    }

    #[test]
    fn real_user_line_counts_as_content() {
        let body = format!("{}\nJe travaille chez Do-Now.\n", CONTEXT_TEMPLATE);
        assert!(context_has_content(&body));
    }
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
