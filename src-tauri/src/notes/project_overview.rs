//! Projets unifiés (spec/28) — vue d'ensemble d'un projet, agrégée en **Rust
//! pur, sans aucun appel Claude** : tâches ouvertes (`todo_md`), notes taguées
//! (`vault::list_notes_with_project`), extrait de la note de contexte
//! (`project_context`) et agenda (`calendar::find_events_for_project`, même
//! heuristique que spec/02 §3c, pas réimplémentée ici). Utilisée à la fois par
//! le tool read-only du chat (`ai::chat`) et par le panneau dédié « Voir
//! l'état du projet » de la vue Projets (spec/07) — zéro appel IA sur ce
//! second chemin.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::path::Path;
use ts_rs::TS;

use crate::calendar::{find_events_for_project, CalendarEvent};
use crate::todos::{self, Todo};

use super::frontmatter;
use super::vault::{self, STATUS_ARCHIVED};

/// Fenêtre agenda de l'overview (spec/28) — plus large que celle des mails
/// (spec/24) : un agenda a besoin de plus de recul dans les deux sens.
const EVENTS_PAST_DAYS: i64 = 7;
const EVENTS_FUTURE_DAYS: i64 = 14;

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ContextExcerpt {
    pub path: String,
    pub excerpt: String,
}

/// Une note taguée à ce projet — pas le contenu complet (spec/28 : « liste
/// organisée », pas une synthèse). `date` vient du frontmatter `date`, `None`
/// si vide (fichier créé/édité à la main sans ce champ).
#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ProjectNoteRef {
    pub path: String,
    pub title: String,
    pub date: Option<String>,
    #[serde(rename = "type")]
    pub note_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ProjectOverview {
    pub project: String,
    pub context_note: Option<ContextExcerpt>,
    pub open_tasks: Vec<Todo>,
    pub notes: Vec<ProjectNoteRef>,
    pub events: Vec<CalendarEvent>,
}

/// Notes taguées `project` = `project` (comparaison exacte — les valeurs
/// viennent du frontmatter, listées telles quelles par `list_projects`),
/// masquant les archivées comme le reste de la vue Projets (spec/07). Triées
/// par date frontmatter desc (les notes sans date retombent en fin).
fn matching_notes(root: &Path, project: &str) -> Result<Vec<ProjectNoteRef>> {
    let all = vault::list_notes_with_project(root)?;
    let mut matched: Vec<ProjectNoteRef> = all
        .into_iter()
        .filter(|n| n.status != STATUS_ARCHIVED && n.project.iter().any(|p| p == project))
        .filter_map(|n| {
            let raw = std::fs::read_to_string(&n.path).ok()?;
            let stem = Path::new(&n.path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let meta = frontmatter::parse(&raw, &stem).0;
            Some(ProjectNoteRef {
                path: n.path,
                title: n.title,
                date: if meta.date.trim().is_empty() { None } else { Some(meta.date) },
                note_type: n.note_type,
            })
        })
        .collect();
    matched.sort_by(|a, b| {
        b.date.clone().unwrap_or_default().cmp(&a.date.clone().unwrap_or_default())
    });
    Ok(matched)
}

/// Agrégation Rust pure (spec/28) — **aucun appel Claude**. Point d'entrée
/// unique partagé par le tool `get_project_overview` du chat et la commande
/// Tauri directe du panneau dédié.
pub async fn get_project_overview(vault_root: &Path, db: &SqlitePool, project: &str) -> Result<ProjectOverview> {
    let project = project.trim().to_string();

    let (root, p) = (vault_root.to_path_buf(), project.clone());
    let notes = tokio::task::spawn_blocking(move || matching_notes(&root, &p)).await??;

    let context_note = super::project_context::project_context_excerpt(vault_root, db, &project).await;

    let open_tasks: Vec<Todo> = todos::get_todos(db, Some(vault_root))
        .await?
        .into_iter()
        .filter(|t| t.project.as_deref() == Some(project.as_str()))
        .collect();

    let now = chrono::Utc::now();
    let window = (
        now - chrono::Duration::days(EVENTS_PAST_DAYS),
        now + chrono::Duration::days(EVENTS_FUTURE_DAYS),
    );
    // Vide (jamais d'erreur) si le calendrier n'est pas connecté (spec/02) —
    // `list_cached_events` interroge juste le cache SQLite local, vide dans ce cas.
    let events = find_events_for_project(db, Some(&project), Some(window)).await.unwrap_or_default();

    Ok(ProjectOverview { project, context_note, open_tasks, notes, events })
}
