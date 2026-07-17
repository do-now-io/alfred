//! Todos (spec/06) — the vault's `Todo.md` file IS the source of truth.
//!
//! The old SQLite `todos` table is gone (migration 007). All operations here
//! read/mutate the Markdown file via `notes::todo_md`. Task identity = the
//! normalized title (unique file-wide by the dedup rule).

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use ts_rs::TS;

use crate::notes::todo_md::{self, IngestTask};

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Todo {
    /// Normalized title — the task's identity in `Todo.md` (no stored ids).
    pub id: String,
    pub title: String,
    pub responsable: Option<String>,
    /// YYYY-MM-DD, when present on the line (`📅`).
    pub echeance: Option<String>,
    /// Which `## Section` the task sits under (Prioritaire / En cours / À faire / Archivé).
    pub section: String,
    pub checked: bool,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct CreateTodoInput {
    pub title: String,
    pub responsable: Option<String>,
    pub echeance: Option<String>,
    /// Section cible (Kanban « + » par colonne, spec/06). Défaut : « À faire ».
    #[serde(default)]
    pub section: Option<String>,
}

/// Vault-relative path of the shared to-do list (spec/06). Configurable via
/// `todo_file_path`; new vaults default under `alfred-intelligence/` alongside
/// the AI-generated compte-rendus (spec/05).
pub const DEFAULT_TODO_FILE: &str = "alfred-intelligence/Todo.md";

pub async fn todo_file_path(db: &SqlitePool) -> String {
    let stored: Option<String> = sqlx::query_scalar("SELECT value FROM config WHERE key = 'todo_file_path'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    stored
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_TODO_FILE.to_string())
}

async fn resolve_path(db: &SqlitePool, vault_root: Option<&Path>) -> Result<PathBuf> {
    let root = vault_root.ok_or_else(|| anyhow!("Aucun dossier Notes (vault) configuré. Réglages → Notes."))?;
    Ok(root.join(todo_file_path(db).await))
}

async fn read_file(path: &Path) -> Option<String> {
    tokio::fs::read_to_string(path).await.ok()
}

async fn write_file(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, content).await?;
    Ok(())
}

fn to_todo(t: todo_md::ParsedTask) -> Todo {
    Todo {
        id: todo_md::normalize_title(&t.titre),
        title: t.titre,
        responsable: t.responsable,
        echeance: t.echeance,
        section: t.section,
        checked: t.checked,
    }
}

/// Pending tasks: unchecked and not archived, in file order.
pub async fn get_todos(db: &SqlitePool, vault_root: Option<&Path>) -> Result<Vec<Todo>> {
    let path = resolve_path(db, vault_root).await?;
    let Some(content) = read_file(&path).await else {
        return Ok(vec![]); // no Todo.md yet = no tasks
    };
    Ok(todo_md::parse_all(&content)
        .into_iter()
        .filter(|t| !t.checked && t.section != "Archivé")
        .map(to_todo)
        .collect())
}

/// Add a task to `## À faire` (deduped by normalized title, spec/06).
pub async fn create_todo(input: &CreateTodoInput, db: &SqlitePool, vault_root: Option<&Path>) -> Result<Todo> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err(anyhow!("Le titre de la tâche est vide"));
    }

    let root = vault_root.ok_or_else(|| anyhow!("Aucun dossier Notes (vault) configuré. Réglages → Notes."))?;
    let rel = todo_file_path(db).await;
    let task = IngestTask {
        titre: title.to_string(),
        responsable: input.responsable.clone().filter(|s| !s.trim().is_empty()),
        echeance: input.echeance.clone().filter(|s| !s.trim().is_empty()),
    };
    todo_md::append_tasks(root, &rel, std::slice::from_ref(&task)).await?;

    // Section cible ≠ « À faire » (ajout rapide Kanban) → déplace la ligne.
    let mut section = "À faire".to_string();
    if let Some(target) = input.section.as_deref().map(str::trim).filter(|s| !s.is_empty() && *s != "À faire") {
        move_todo(&todo_md::normalize_title(title), target, None, db, vault_root).await?;
        section = target.to_string();
    }

    Ok(Todo {
        id: todo_md::normalize_title(title),
        title: title.to_string(),
        responsable: task.responsable,
        echeance: task.echeance,
        section,
        checked: false,
    })
}

/// TOUTES les tâches (cochées et archivées comprises), dans l'ordre du fichier —
/// pour la vue Kanban (spec/06 : colonnes = sections, Archivé compris).
pub async fn get_all_todos(db: &SqlitePool, vault_root: Option<&Path>) -> Result<Vec<Todo>> {
    let path = resolve_path(db, vault_root).await?;
    let Some(content) = read_file(&path).await else {
        return Ok(vec![]);
    };
    Ok(todo_md::parse_all(&content).into_iter().map(to_todo).collect())
}

/// Déplace une tâche vers `section` à `position` (Kanban, spec/06) — conserve
/// responsable / échéance / état coché.
pub async fn move_todo(
    id: &str,
    section: &str,
    position: Option<usize>,
    db: &SqlitePool,
    vault_root: Option<&Path>,
) -> Result<()> {
    let path = resolve_path(db, vault_root).await?;
    let content = read_file(&path).await.ok_or_else(|| anyhow!("Todo.md introuvable"))?;
    let new_content = todo_md::move_task(&content, id, section, position)?;
    write_file(&path, &new_content).await
}

/// Toggle done: check/uncheck in place (spec/06 — the line never moves).
pub async fn set_todo_checked(id: &str, checked: bool, db: &SqlitePool, vault_root: Option<&Path>) -> Result<()> {
    let path = resolve_path(db, vault_root).await?;
    let content = read_file(&path).await.ok_or_else(|| anyhow!("Todo.md introuvable"))?;
    let new_content = todo_md::set_checked(&content, id, checked)?;
    write_file(&path, &new_content).await
}

/// Archive (ex-« ignorer ») : move the task to `## Archivé` — nothing is deleted.
pub async fn archive_todo(id: &str, db: &SqlitePool, vault_root: Option<&Path>) -> Result<()> {
    let path = resolve_path(db, vault_root).await?;
    let content = read_file(&path).await.ok_or_else(|| anyhow!("Todo.md introuvable"))?;
    let new_content = todo_md::archive_task(&content, id)?;
    write_file(&path, &new_content).await
}

/// Rewrite a task's title / responsable / échéance in place.
pub async fn update_todo(id: &str, input: &CreateTodoInput, db: &SqlitePool, vault_root: Option<&Path>) -> Result<Todo> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err(anyhow!("Le titre de la tâche est vide"));
    }

    let path = resolve_path(db, vault_root).await?;
    let content = read_file(&path).await.ok_or_else(|| anyhow!("Todo.md introuvable"))?;
    let task = IngestTask {
        titre: title.to_string(),
        responsable: input.responsable.clone().filter(|s| !s.trim().is_empty()),
        echeance: input.echeance.clone().filter(|s| !s.trim().is_empty()),
    };
    let new_content = todo_md::edit_task(&content, id, &task)?;
    write_file(&path, &new_content).await?;

    // Re-read to return the task's actual state (section + checked preserved).
    let updated = todo_md::parse_all(&new_content)
        .into_iter()
        .find(|t| todo_md::normalize_title(&t.titre) == todo_md::normalize_title(title))
        .ok_or_else(|| anyhow!("Tâche modifiée mais introuvable à la relecture"))?;
    Ok(to_todo(updated))
}
