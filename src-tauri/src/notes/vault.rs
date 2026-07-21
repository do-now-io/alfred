use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use ts_rs::TS;
use walkdir::WalkDir;

use super::frontmatter::{self, NoteMetadata};

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VaultNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<VaultNode>,
    /// Frontmatter `status` (spec/07) — `None` for directories. Drives the
    /// default hide + dimmed/badge display of archived notes in the tree.
    pub status: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct NoteFile {
    pub path: String,
    pub metadata: NoteMetadata,
    pub body: String,
    pub word_count: usize,
    pub char_count: usize,
    pub prop_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct RecentNote {
    pub path: String,
    pub title: String,
    /// Last filesystem modification time, in Unix seconds.
    pub modified: i64,
    /// Frontmatter `type` — pour l'icône de type dans les Récents (spec/07).
    #[serde(rename = "type")]
    pub note_type: String,
    /// Présent sur la paire transcription/compte-rendu (icône + apparaige).
    pub recording_id: Option<String>,
}

/// Raw frontmatter `status` value that hides a note from the tree/Récents by
/// default (spec/07 — archivage auto de la transcription après ingestion).
pub const STATUS_ARCHIVED: &str = "archived";

// ─── Tree ─────────────────────────────────────────────────────────────────────

pub fn get_vault_tree(root: &Path) -> Result<VaultNode> {
    if !root.exists() {
        return Err(anyhow!("Vault folder does not exist: {:?}", root));
    }
    Ok(build_node(root, root))
}

fn build_node(path: &Path, root: &Path) -> VaultNode {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());

    if path.is_file() {
        // Lu pour le seul champ `status` (spec/07 — masquage des archivées) ;
        // coût acceptable pour les petits vaults visés (~10 users), même
        // pattern déjà utilisé par `list_recent_notes`/`list_notes_with_project`.
        let status = std::fs::read_to_string(path).ok().map(|raw| {
            let stem = stem(&name);
            frontmatter::parse(&raw, &stem).0.status
        });
        return VaultNode {
            name: stem(&name),
            path: path.to_string_lossy().to_string(),
            is_dir: false,
            children: vec![],
            status,
        };
    }

    // Directory — collect children
    let mut dirs: Vec<VaultNode> = vec![];
    let mut files: Vec<VaultNode> = vec![];

    if let Ok(entries) = std::fs::read_dir(path) {
        let mut sorted: Vec<_> = entries
            .filter_map(|e| e.ok())
            .filter(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                !n.starts_with('.') // skip hidden
            })
            .collect();
        sorted.sort_by_key(|e| e.file_name());

        for entry in sorted {
            let child_path = entry.path();
            if child_path.is_dir() {
                dirs.push(build_node(&child_path, root));
            } else if child_path.extension().map(|e| e == "md").unwrap_or(false) {
                files.push(build_node(&child_path, root));
            }
        }
    }

    dirs.extend(files);

    let display_name = if path == root {
        path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string())
    } else {
        name
    };

    VaultNode {
        name: display_name,
        path: path.to_string_lossy().to_string(),
        is_dir: true,
        children: dirs,
        status: None,
    }
}

fn stem(filename: &str) -> String {
    if filename.ends_with(".md") {
        filename[..filename.len() - 3].to_string()
    } else {
        filename.to_string()
    }
}

// ─── Recently modified ─────────────────────────────────────────────────────────

/// The `limit` most recently *modified* `.md` notes in the vault, excluding
/// archived ones (`status: archived`, spec/07) — a raw transcription archived
/// right after ingestion must not clutter Récents.
///
/// Ordering is by filesystem mtime, which advances when a file is written
/// (saved/edited) but never when it is merely read — so opening a note to view
/// it does not bump it up this list.
pub fn list_recent_notes(root: &Path, limit: usize) -> Result<Vec<RecentNote>> {
    if !root.exists() {
        return Err(anyhow!("Vault folder does not exist: {:?}", root));
    }

    // Archived notes must be filtered out BEFORE truncating to `limit` (else a
    // recently-archived transcription could crowd out a real recent note), so
    // frontmatter has to be read for every candidate up front, not just the
    // mtime-sorted survivors — fine for the small vaults of ~10 users.
    let mut entries: Vec<(PathBuf, SystemTime, frontmatter::NoteMetadata)> = WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path().extension().map(|x| x == "md").unwrap_or(false)
                // skip anything under a hidden file or directory
                && !e
                    .path()
                    .components()
                    .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        })
        .filter_map(|e| {
            let modified = e.metadata().ok()?.modified().ok()?;
            let path = e.path().to_path_buf();
            let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let meta = std::fs::read_to_string(&path)
                .map(|raw| frontmatter::parse(&raw, &stem).0)
                .unwrap_or_else(|_| frontmatter::NoteMetadata::new(&stem));
            if meta.status == STATUS_ARCHIVED {
                return None;
            }
            Some((path, modified, meta))
        })
        .collect();

    // Most recent first, then keep only the top `limit`.
    entries.sort_by(|a, b| b.1.cmp(&a.1));
    entries.truncate(limit);

    let recents = entries
        .into_iter()
        .map(|(path, modified, meta)| {
            let modified = modified
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            RecentNote {
                path: path.to_string_lossy().to_string(),
                title: meta.title,
                modified,
                note_type: meta.note_type,
                recording_id: meta.recording_id,
            }
        })
        .collect();

    Ok(recents)
}

/// A note plus its `project` frontmatter, for the "group by project" view (spec/07).
#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ProjectNote {
    pub path: String,
    pub title: String,
    /// Liste vide → « Sans projet ». Une note peut relever de plusieurs projets
    /// (elle apparaît sous chacun — feedback tests, spec/07).
    pub project: Vec<String>,
    #[serde(rename = "type")]
    pub note_type: String,
    /// Lien de paire transcription ↔ compte-rendu (spec/07) : le compte-rendu
    /// porte le projet, la transcription est affichée avec lui via ce champ.
    pub recording_id: Option<String>,
}

/// Every `.md` note in the vault with its title/project/type, for virtual
/// grouping by project in the Notes UI (spec/07 — no file is moved). Reads each
/// note's frontmatter; fine for the small vaults of ~10 users.
pub fn list_notes_with_project(root: &Path) -> Result<Vec<ProjectNote>> {
    if !root.exists() {
        return Err(anyhow!("Vault folder does not exist: {:?}", root));
    }
    let notes = WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path().extension().map(|x| x == "md").unwrap_or(false)
                && !e
                    .path()
                    .components()
                    .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        })
        .filter_map(|e| {
            let path = e.path();
            let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let raw = std::fs::read_to_string(path).ok()?;
            let meta = frontmatter::parse(&raw, &stem).0;
            let project: Vec<String> = meta
                .project
                .iter()
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect();
            Some(ProjectNote {
                path: path.to_string_lossy().to_string(),
                title: meta.title,
                project,
                note_type: meta.note_type,
                recording_id: meta.recording_id,
            })
        })
        .collect();
    Ok(notes)
}

/// Valeurs `project` distinctes du vault, triées — pour la combobox Projet du
/// panneau Properties et le glisser-déposer de la vue Projets (spec/07).
pub fn list_projects(root: &Path) -> Result<Vec<String>> {
    let notes = list_notes_with_project(root)?;
    let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for note in notes {
        set.extend(note.project);
    }
    Ok(set.into_iter().collect())
}

// ─── File I/O ─────────────────────────────────────────────────────────────────

pub async fn get_note_file(path: &Path) -> Result<NoteFile> {
    let raw = tokio::fs::read_to_string(path).await
        .map_err(|e| anyhow!("Cannot read {:?}: {}", path, e))?;

    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let (metadata, body) = frontmatter::parse(&raw, &stem);
    let word_count = count_words(&body);
    let char_count = body.chars().count();
    let prop_count = metadata.prop_count();

    Ok(NoteFile {
        path: path.to_string_lossy().to_string(),
        metadata,
        body,
        word_count,
        char_count,
        prop_count,
    })
}

pub async fn create_note_file(folder: &Path, title: &str) -> Result<NoteFile> {
    tokio::fs::create_dir_all(folder).await?;

    let safe_name = sanitize_filename(title);
    let mut file_path = folder.join(format!("{}.md", safe_name));

    // Avoid collision
    let mut counter = 2;
    while file_path.exists() {
        file_path = folder.join(format!("{} {}.md", safe_name, counter));
        counter += 1;
    }

    let metadata = NoteMetadata::new(title);
    let content = frontmatter::serialize(&metadata, "");
    tokio::fs::write(&file_path, content).await?;

    get_note_file(&file_path).await
}

pub async fn create_recording_note(
    folder: &Path,
    title: &str,
    recording_id: &str,
    transcription_text: &str,
) -> Result<NoteFile> {
    tokio::fs::create_dir_all(folder).await?;

    let safe_name = sanitize_filename(title);
    let mut file_path = folder.join(format!("{}.md", safe_name));
    let mut counter = 2;
    while file_path.exists() {
        file_path = folder.join(format!("{} {}.md", safe_name, counter));
        counter += 1;
    }

    // Frontmatter (spec/07): type meeting + recording_id — the link the
    // "ré-ingérer" flow (spec/05) uses to tie the note back to its recording.
    // participants/project stay empty on the raw note (filled by AI later).
    let metadata = NoteMetadata::for_recording(title, recording_id);
    let body = format!("# Transcription\n\n{}", transcription_text);
    let content = frontmatter::serialize(&metadata, &body);
    tokio::fs::write(&file_path, content).await?;

    get_note_file(&file_path).await
}

/// Write the AI-generated compte-rendu (spec/05) as a fresh note with frontmatter
/// — unlike `create_recording_note`, which writes the raw transcription without
/// frontmatter (spec/04, a separate not-yet-done cleanup task).
pub async fn create_intelligence_note(
    folder: &Path,
    title: &str,
    metadata: NoteMetadata,
    body: &str,
) -> Result<NoteFile> {
    tokio::fs::create_dir_all(folder).await?;

    let safe_name = sanitize_filename(title);
    let mut file_path = folder.join(format!("{}.md", safe_name));
    let mut counter = 2;
    while file_path.exists() {
        file_path = folder.join(format!("{} {}.md", safe_name, counter));
        counter += 1;
    }

    let content = frontmatter::serialize(&metadata, body);
    tokio::fs::write(&file_path, content).await?;

    get_note_file(&file_path).await
}

pub async fn update_note_file(
    path: &Path,
    metadata: NoteMetadata,
    body: &str,
) -> Result<NoteFile> {
    let content = frontmatter::serialize(&metadata, body);
    tokio::fs::write(path, content).await
        .map_err(|e| anyhow!("Cannot write {:?}: {}", path, e))?;
    get_note_file(path).await
}

/// Archive la note brute de transcription (`recording_folder`) liée à
/// `recording_id`, une fois son compte-rendu écrit (spec/05/07) — `status:
/// archived`, rien n'est supprimé, le WAV reste réécoutable. Best-effort et
/// silencieux : une erreur ici ne doit jamais faire échouer l'ingestion, qui
/// a déjà réussi son travail principal (compte-rendu + tâches).
pub async fn archive_raw_note_by_recording_id(vault_root: &Path, recording_folder: &str, recording_id: &str) {
    let folder = vault_root.join(recording_folder);
    let found = WalkDir::new(&folder)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && e.path().extension().map(|x| x == "md").unwrap_or(false))
        .find_map(|e| {
            let path = e.path();
            let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let raw = std::fs::read_to_string(path).ok()?;
            let meta = frontmatter::parse(&raw, &stem).0;
            (meta.recording_id.as_deref() == Some(recording_id)).then(|| path.to_path_buf())
        });

    let Some(path) = found else {
        eprintln!("[ingestion] raw note for recording_id={} not found, skipping archive", recording_id);
        return;
    };

    match get_note_file(&path).await {
        Ok(note) if note.metadata.status == STATUS_ARCHIVED => {} // already archived, nothing to do
        Ok(note) => {
            let mut metadata = note.metadata;
            metadata.status = STATUS_ARCHIVED.to_string();
            if let Err(e) = update_note_file(&path, metadata, &note.body).await {
                eprintln!("[ingestion] failed to archive raw note {:?}: {}", path, e);
            }
        }
        Err(e) => eprintln!("[ingestion] failed to read raw note {:?} for archiving: {}", path, e),
    }
}

pub async fn rename_note_file(old_path: &Path, new_name: &str) -> Result<NoteFile> {
    let safe = sanitize_filename(new_name);
    let new_path = old_path
        .parent()
        .ok_or_else(|| anyhow!("No parent dir"))?
        .join(format!("{}.md", safe));

    if new_path.exists() {
        return Err(anyhow!("A note named '{}' already exists in this folder", new_name));
    }

    tokio::fs::rename(old_path, &new_path).await?;

    // Update title in frontmatter to match new name
    let mut note = get_note_file(&new_path).await?;
    note.metadata.title = new_name.to_string();
    update_note_file(&new_path, note.metadata, &note.body).await
}

pub async fn delete_note_file(path: &Path) -> Result<()> {
    tokio::fs::remove_file(path).await
        .map_err(|e| anyhow!("Cannot delete {:?}: {}", path, e))
}

/// Move a note into a different folder, keeping its filename (collision →
/// numbered suffix, same convention as `create_note_file`). Used by the
/// tree's drag & drop onto a folder (spec/07).
pub async fn move_note_file(path: &Path, dest_folder: &Path) -> Result<NoteFile> {
    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow!("No file name"))?;
    if path.parent() == Some(dest_folder) {
        return get_note_file(path).await; // already there — no-op
    }

    tokio::fs::create_dir_all(dest_folder).await?;

    let mut new_path = dest_folder.join(file_name);
    if new_path.exists() {
        let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let mut counter = 2;
        loop {
            new_path = dest_folder.join(format!("{} {}.md", stem, counter));
            if !new_path.exists() { break; }
            counter += 1;
        }
    }

    tokio::fs::rename(path, &new_path).await
        .map_err(|e| anyhow!("Cannot move {:?} to {:?}: {}", path, new_path, e))?;
    get_note_file(&new_path).await
}

// ─── Folders ────────────────────────────────────────────────────────────────

pub async fn create_folder(parent: &Path, name: &str) -> Result<String> {
    let safe = sanitize_filename(name);
    if safe.is_empty() {
        return Err(anyhow!("Nom de dossier invalide"));
    }
    let mut folder_path = parent.join(&safe);
    let mut counter = 2;
    while folder_path.exists() {
        folder_path = parent.join(format!("{} {}", safe, counter));
        counter += 1;
    }
    tokio::fs::create_dir_all(&folder_path).await
        .map_err(|e| anyhow!("Cannot create folder {:?}: {}", folder_path, e))?;
    Ok(folder_path.to_string_lossy().to_string())
}

pub async fn rename_folder(old_path: &Path, new_name: &str) -> Result<String> {
    let safe = sanitize_filename(new_name);
    if safe.is_empty() {
        return Err(anyhow!("Nom de dossier invalide"));
    }
    let new_path = old_path
        .parent()
        .ok_or_else(|| anyhow!("No parent dir"))?
        .join(&safe);

    if new_path.exists() {
        return Err(anyhow!("Un dossier nommé « {} » existe déjà ici", new_name));
    }

    tokio::fs::rename(old_path, &new_path).await
        .map_err(|e| anyhow!("Cannot rename folder {:?}: {}", old_path, e))?;
    Ok(new_path.to_string_lossy().to_string())
}

pub async fn delete_folder(path: &Path) -> Result<()> {
    tokio::fs::remove_dir_all(path).await
        .map_err(|e| anyhow!("Cannot delete folder {:?}: {}", path, e))
}

// ─── Vault scaffolding (spec/13 onboarding) ─────────────────────────────────────

/// Idempotently create the vault's expected structure on first setup:
/// `alfred-raw/`, `alfred-intelligence/`, and a skeleton `Todo.md` (spec/06's
/// four sections) if one doesn't already exist. Never overwrites existing files.
pub async fn scaffold_vault(
    vault_root: &Path,
    recording_folder: &str,
    intelligence_folder: &str,
    todo_rel_path: &str,
) -> Result<()> {
    tokio::fs::create_dir_all(vault_root.join(recording_folder)).await?;
    tokio::fs::create_dir_all(vault_root.join(intelligence_folder)).await?;

    let todo_path = vault_root.join(todo_rel_path);
    if !todo_path.exists() {
        if let Some(parent) = todo_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let (skeleton, _) = crate::notes::todo_md::merge_tasks(None, &[], None);
        tokio::fs::write(&todo_path, skeleton).await?;
    }

    Ok(())
}

// ─── SQLite → vault migration ─────────────────────────────────────────────────

pub async fn migrate_sqlite_to_vault(
    db: &sqlx::SqlitePool,
    vault_root: &Path,
) -> Result<usize> {
    let legacy_folder = vault_root.join("Legacy");

    let rows = sqlx::query!(
        r#"SELECT id as "id!", title as "title!", body as "body!", recording_id, created_at as "created_at!" FROM notes WHERE migrated_at IS NULL"#
    )
    .fetch_all(db)
    .await?;

    if rows.is_empty() {
        return Ok(0);
    }

    tokio::fs::create_dir_all(&legacy_folder).await?;
    let mut count = 0;

    for row in rows {
        let title = row.title;
        let body = row.body;
        let date = row.created_at.get(..10).unwrap_or("2026-01-01").to_string();

        let mut metadata = NoteMetadata::new(&title);
        metadata.date = date;
        metadata.recording_id = row.recording_id;

        let safe_name = sanitize_filename(&title);
        let mut file_path = legacy_folder.join(format!("{}.md", safe_name));
        let mut c = 2;
        while file_path.exists() {
            file_path = legacy_folder.join(format!("{} {}.md", safe_name, c));
            c += 1;
        }

        let content = frontmatter::serialize(&metadata, &body);
        let _ = tokio::fs::write(&file_path, content).await;

        let now = chrono::Utc::now().to_rfc3339();
        let _ = sqlx::query!(
            "UPDATE notes SET migrated_at = ? WHERE id = ?",
            now,
            row.id
        )
        .execute(db)
        .await;

        count += 1;
    }

    eprintln!("[notes/migrate] exported {} SQLite notes to {:?}", count, legacy_folder);
    Ok(count)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn sanitize_filename(name: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c => c,
        })
        .collect();
    let safe = safe.trim().to_string();
    if safe.len() > 80 { safe[..80].to_string() } else { safe }
}

fn count_words(text: &str) -> usize {
    text.split_whitespace().count()
}
