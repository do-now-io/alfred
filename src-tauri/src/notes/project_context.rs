//! Contexte par projet (spec/16b) — second niveau de contexte, en plus du
//! contexte global (spec/16). Une note `alfred-intelligence/<Projet>.md` par
//! projet, `type: context` + `project: [<Nom>]`, contenant une seule section
//! `## Appris automatiquement` — pas de template à 4 sections comme le global
//! (pas de « mon entreprise »/« équipe » à ce niveau). Créée lazily au premier
//! fait `scope: "project"` confirmé pour ce projet ; sa toute première
//! création rescanne l'historique du projet (`build_project_context_retroactive`)
//! pour ne pas repartir d'une fiche vide.

use anyhow::Result;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};

use super::frontmatter;

/// ~8 000 caractères d'historique (comptes-rendus les plus récents en
/// premier) envoyés à Claude pour la reconstruction rétroactive (spec/16b §4,
/// « à trancher à l'implémentation ») — repli raisonnable, un vault de test
/// (~10 utilisateurs) n'a pas des historiques de projet démesurés ; à
/// resserrer si un cas réel dépasse ce budget en pratique.
const RETRO_HISTORY_MAX_CHARS: usize = 8_000;

async fn lang(db: &SqlitePool) -> String {
    crate::ai::app_language(db).await
}

/// Cherche une note de contexte de projet DÉJÀ existante par frontmatter
/// (`type: context` + `project` contenant exactement ce nom) plutôt que par
/// chemin calculé — le chemin peut avoir été suffixé à la création si son nom
/// sanitizé entrait en collision avec une note existante (spec/16b §4,
/// « collision → suffixe, comme les autres notes »).
fn find_project_context_note(intelligence_folder: &Path, project: &str) -> Option<PathBuf> {
    let notes = super::vault::list_notes_with_project(intelligence_folder).ok()?;
    notes
        .into_iter()
        .find(|n| n.note_type == "context" && n.project.iter().any(|p| p == project))
        .map(|n| PathBuf::from(n.path))
}

/// Lazy-create la note de contexte de ce projet si elle n'existe pas encore.
/// Renvoie `(chemin, true)` si elle vient d'être créée à l'instant (déclenche
/// la reconstruction rétroactive côté appelant) — `(chemin, false)` sinon.
async fn get_or_create_project_context_note(
    vault_root: &Path,
    db: &SqlitePool,
    project: &str,
) -> Result<(PathBuf, bool)> {
    let folder = vault_root.join(crate::ai::intelligence_folder(db).await);
    if let Some(path) = find_project_context_note(&folder, project) {
        return Ok((path, false));
    }

    tokio::fs::create_dir_all(&folder).await?;
    let safe = super::vault::sanitize_filename(project);
    let mut path = folder.join(format!("{}.md", safe));
    let mut counter = 2;
    while path.exists() {
        path = folder.join(format!("{} {}.md", safe, counter));
        counter += 1;
    }

    let metadata = super::NoteMetadata::for_context(project, Some(project));
    let heading = super::context::titles(&lang(db).await).learned_auto;
    let body = format!("# {}\n\n## {}\n", project, heading);
    let content = frontmatter::serialize(&metadata, &body);
    tokio::fs::write(&path, content).await?;

    Ok((path, true))
}

/// Concatène l'historique des comptes-rendus déjà tagués `project: <Nom>`
/// (les plus récents en premier, tronqué à `RETRO_HISTORY_MAX_CHARS`) pour la
/// reconstruction rétroactive (spec/16b §4). `exclude_path` écarte la note de
/// contexte de projet elle-même si elle apparaissait déjà dans le vault (ne
/// devrait pas arriver — appelé juste après sa création — mais robuste si un
/// jour cette fonction est réutilisée ailleurs).
fn collect_project_history(vault_root: &Path, project: &str, exclude_path: &Path) -> Result<String> {
    let mut notes = super::vault::list_notes_with_project(vault_root)?;
    notes.retain(|n| {
        n.project.iter().any(|p| p == project) && n.note_type != "context" && Path::new(&n.path) != exclude_path
    });

    let mut with_mtime: Vec<(PathBuf, std::time::SystemTime)> = notes
        .into_iter()
        .filter_map(|n| {
            let path = PathBuf::from(&n.path);
            let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
            Some((path, modified))
        })
        .collect();
    with_mtime.sort_by(|a, b| b.1.cmp(&a.1)); // most recent first

    let mut history = String::new();
    for (path, _) in with_mtime {
        if history.chars().count() >= RETRO_HISTORY_MAX_CHARS {
            break;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let (_, body) = frontmatter::parse(&raw, &stem);
        history.push_str(&format!("--- {} ---\n{}\n\n", stem, body.trim()));
    }

    Ok(history.chars().take(RETRO_HISTORY_MAX_CHARS).collect())
}

/// Reconstruction rétroactive (spec/16b §4) : au premier fait `scope:
/// "project"` confirmé pour un projet qui n'a pas encore de note, rescanne
/// tout son historique de comptes-rendus et en extrait les faits durables
/// via un appel Claude dédié, avant que le fait qui a déclenché la création
/// ne soit lui-même ajouté par l'appelant. Best-effort : une erreur ici ne
/// doit jamais empêcher l'écriture du fait courant.
async fn build_project_context_retroactive(vault_root: &Path, db: &SqlitePool, project: &str, note_path: &Path) -> Result<()> {
    let history = collect_project_history(vault_root, project, note_path)?;
    if history.trim().is_empty() {
        return Ok(());
    }
    let facts = crate::ai::extract_project_facts(&history, project, db).await?;
    if facts.is_empty() {
        return Ok(());
    }
    append_facts(note_path, &facts).await?;
    Ok(())
}

/// Append `facts` under the note's `## Appris automatiquement` section,
/// deduped against existing bullets — same pattern as
/// `context::append_learned_facts`, but scoped to a single fixed section (no
/// 4-slot template at this level, spec/16b §4).
async fn append_facts(path: &Path, facts: &[String]) -> Result<usize> {
    let clean: Vec<String> = facts.iter().map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).collect();
    if clean.is_empty() {
        return Ok(0);
    }

    let raw = tokio::fs::read_to_string(path).await?;
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let (metadata, body) = frontmatter::parse(&raw, &stem);

    let existing: std::collections::HashSet<String> = body
        .lines()
        .filter_map(|l| l.trim().strip_prefix("- "))
        .map(|l| l.trim().to_lowercase())
        .collect();
    let to_add: Vec<&String> = clean.iter().filter(|f| !existing.contains(&f.to_lowercase())).collect();
    if to_add.is_empty() {
        return Ok(0);
    }

    let (fr, en) = super::context::learned_heading_variants();
    let has_heading = body.lines().any(|l| {
        let t = l.trim();
        t == format!("## {}", fr) || t == format!("## {}", en)
    });

    let mut new_body = body.trim_end().to_string();
    if has_heading {
        let mut out = String::new();
        let mut inserted = false;
        for line in new_body.lines() {
            out.push_str(line);
            out.push('\n');
            let t = line.trim();
            let is_heading = t == format!("## {}", fr) || t == format!("## {}", en);
            if !inserted && is_heading {
                for f in &to_add {
                    out.push_str(&format!("- {}\n", f.trim()));
                }
                inserted = true;
            }
        }
        new_body = out.trim_end().to_string();
    } else {
        new_body.push_str(&format!("\n\n## {}\n", fr));
        for f in &to_add {
            new_body.push_str(&format!("- {}\n", f.trim()));
        }
        new_body = new_body.trim_end().to_string();
    }

    let content = frontmatter::serialize(&metadata, &format!("{}\n", new_body));
    tokio::fs::write(path, content).await?;
    Ok(to_add.len())
}

/// Nombre de lignes non vides gardées dans l'extrait (spec/28) — un lien +
/// court extrait, pas le contenu intégral (« liste organisée », pas une
/// synthèse narrative).
const OVERVIEW_EXCERPT_LINES: usize = 3;

/// Court extrait de la note de contexte de ce projet (spec/28), pour
/// `ProjectOverview.context_note` — présence + 2-3 lignes, jamais le contenu
/// complet. `None` si le projet n'a pas encore de note de contexte (jamais
/// créée ici — lecture seule, contrairement à `write_project_context_fact`).
pub async fn project_context_excerpt(
    vault_root: &Path,
    db: &SqlitePool,
    project: &str,
) -> Option<super::project_overview::ContextExcerpt> {
    let folder = vault_root.join(crate::ai::intelligence_folder(db).await);
    let path = find_project_context_note(&folder, project)?;
    let raw = tokio::fs::read_to_string(&path).await.ok()?;
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let (_, body) = frontmatter::parse(&raw, &stem);

    let excerpt = body
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .take(OVERVIEW_EXCERPT_LINES)
        .collect::<Vec<_>>()
        .join("\n");
    if excerpt.is_empty() {
        return None;
    }

    Some(super::project_overview::ContextExcerpt { path: path.to_string_lossy().to_string(), excerpt })
}

/// Écrit `facts` dans la note de contexte de ce projet (créée lazily — avec
/// reconstruction rétroactive au besoin, spec/16b §4). Point d'entrée utilisé
/// par `finalize_ingestion` pour router les `context_addition` à `scope:
/// "project"` (spec/16b §3). Retourne le nombre de faits effectivement
/// ajoutés (dédupliqués contre l'existant).
pub async fn write_project_context_fact(vault_root: &Path, db: &SqlitePool, project: &str, facts: &[String]) -> Result<usize> {
    let clean: Vec<String> = facts.iter().map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).collect();
    if clean.is_empty() {
        return Ok(0);
    }

    let (path, just_created) = get_or_create_project_context_note(vault_root, db, project).await?;
    if just_created {
        if let Err(e) = build_project_context_retroactive(vault_root, db, project, &path).await {
            eprintln!("[project_context] retroactive build failed for {}: {}", project, e);
        }
    }

    append_facts(&path, &clean).await
}
