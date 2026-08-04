//! Contexte par projet (spec/16b) — second niveau de contexte, en plus du
//! contexte global (spec/16). Une note `alfred-intelligence/<Projet>.md` par
//! projet, `type: context` + `project: [<Nom>]`, structurée en **6 sections**
//! (aperçu / personnes / décisions / événements / tâches / vocabulaire) —
//! chaque fait `scope: "project"` est classé dans la bonne section par Claude
//! (`ContextAddition.section`), plutôt que déversé dans un unique bloc
//! générique. Titres localisés FR/EN comme le contexte global (`notes::context`).
//! Créée lazily au premier fait `scope: "project"` confirmé pour ce projet ;
//! sa toute première création rescanne l'historique du projet
//! (`build_project_context_retroactive`) pour ne pas repartir d'une fiche vide.

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

/// Clé interne stable (langue-indépendante — comme `company`/`team`/`vocab`/
/// `projects` dans `notes::context`) pour chacune des 6 sections de la note de
/// projet. C'est la valeur attendue dans `ContextAddition.section` (schéma
/// d'analyse, `ai/mod.rs`) — le TITRE affiché, lui, suit `app_language`.
pub const SECTION_KEYS: [&str; 6] = ["overview", "people", "decisions", "events", "tasks", "vocabulary"];

struct ProjectSectionTitles {
    overview: &'static str,
    people: &'static str,
    decisions: &'static str,
    events: &'static str,
    tasks: &'static str,
    vocabulary: &'static str,
}

const TITLES_FR: ProjectSectionTitles = ProjectSectionTitles {
    overview: "Aperçu",
    people: "Personnes",
    decisions: "Décisions",
    events: "Événements",
    tasks: "Tâches",
    vocabulary: "Vocabulaire",
};

const TITLES_EN: ProjectSectionTitles = ProjectSectionTitles {
    overview: "Overview",
    people: "People",
    decisions: "Decisions",
    events: "Events",
    tasks: "Tasks",
    vocabulary: "Vocabulary",
};

fn titles(lang: &str) -> &'static ProjectSectionTitles {
    if lang == "en" { &TITLES_EN } else { &TITLES_FR }
}

/// Ordered (key, FR title, EN title) — drives the template, the canonical-slot
/// matching, and the section→heading lookup, all from one place.
fn section_table() -> [(&'static str, &'static str, &'static str); 6] {
    [
        (SECTION_KEYS[0], TITLES_FR.overview, TITLES_EN.overview),
        (SECTION_KEYS[1], TITLES_FR.people, TITLES_EN.people),
        (SECTION_KEYS[2], TITLES_FR.decisions, TITLES_EN.decisions),
        (SECTION_KEYS[3], TITLES_FR.events, TITLES_EN.events),
        (SECTION_KEYS[4], TITLES_FR.tasks, TITLES_EN.tasks),
        (SECTION_KEYS[5], TITLES_FR.vocabulary, TITLES_EN.vocabulary),
    ]
}

/// A `## ` heading written in either language → its stable section key,
/// regardless of `app_language` at write time (same robustness pattern as
/// `notes::context::canonical_slot`).
fn heading_to_key(heading: &str) -> Option<&'static str> {
    let h = heading.trim();
    section_table().into_iter().find(|(_, fr, en)| h.eq_ignore_ascii_case(fr) || h.eq_ignore_ascii_case(en)).map(|(k, _, _)| k)
}

fn key_to_heading(key: &str, lang: &str) -> &'static str {
    let en = lang == "en";
    section_table().into_iter().find(|(k, _, _)| *k == key).map(|(_, fr, en_t)| if en { en_t } else { fr }).unwrap_or(if en { "Overview" } else { "Aperçu" })
}

fn project_template(project: &str, lang: &str) -> String {
    let t = titles(lang);
    format!(
        "# {}\n\n## {}\n\n## {}\n\n## {}\n\n## {}\n\n## {}\n\n## {}\n",
        project, t.overview, t.people, t.decisions, t.events, t.tasks, t.vocabulary
    )
}

/// Splits a note body into the leading preamble (everything before the first
/// `## ` heading — the `# Titre`) and its ordered `## ` section blocks. Same
/// shape as `notes::context::split_sections` (kept private/duplicated here —
/// the two note kinds have different section sets and no shared caller).
fn split_sections(body: &str) -> (String, Vec<(String, String)>) {
    let mut preamble: Vec<&str> = Vec::new();
    let mut sections: Vec<(String, Vec<&str>)> = Vec::new();
    for line in body.lines() {
        if let Some(h) = line.trim_start().strip_prefix("## ") {
            sections.push((h.trim().to_string(), Vec::new()));
        } else if let Some(last) = sections.last_mut() {
            last.1.push(line);
        } else {
            preamble.push(line);
        }
    }
    (
        preamble.join("\n"),
        sections.into_iter().map(|(h, lines)| (h, lines.join("\n"))).collect(),
    )
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
    let body = project_template(project, &lang(db).await);
    let content = frontmatter::serialize(&metadata, &body);
    tokio::fs::write(&path, content).await?;

    Ok((path, true))
}

/// Ouvre (crée lazily au besoin, avec reconstruction rétroactive) la note de
/// contexte de ce projet — point d'entrée du clic sur le nom du projet dans la
/// vue Projets (spec/16b, spec/07 : « un seul fichier de contexte par projet,
/// accessible en cliquant sur son nom »).
pub async fn open_project_context_note(vault_root: &Path, db: &SqlitePool, project: &str) -> Result<PathBuf> {
    let (path, just_created) = get_or_create_project_context_note(vault_root, db, project).await?;
    if just_created {
        if let Err(e) = build_project_context_retroactive(vault_root, db, project, &path).await {
            eprintln!("[project_context] retroactive build failed for {}: {}", project, e);
        }
    }
    Ok(path)
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
/// tout son historique de comptes-rendus et en extrait les faits durables,
/// déjà classés par section, via un appel Claude dédié — avant que le fait qui
/// a déclenché la création ne soit lui-même ajouté par l'appelant. Best-effort :
/// une erreur ici ne doit jamais empêcher l'écriture du fait courant.
async fn build_project_context_retroactive(vault_root: &Path, db: &SqlitePool, project: &str, note_path: &Path) -> Result<()> {
    let history = collect_project_history(vault_root, project, note_path)?;
    if history.trim().is_empty() {
        return Ok(());
    }
    let sections = crate::ai::extract_project_facts(&history, project, db).await?;
    for (key, facts) in sections.into_iter() {
        if !facts.is_empty() {
            append_facts_to_section(note_path, &key, &facts).await?;
        }
    }
    Ok(())
}

/// Append `facts` under the note's section identified by `section_key`
/// (`SECTION_KEYS`), deduped against existing bullets anywhere in the note —
/// recreates the section (localised, at the end) if the user had deleted it.
async fn append_facts_to_section(path: &Path, section_key: &str, facts: &[String]) -> Result<usize> {
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

    let (preamble, sections) = split_sections(&body);
    let mut out_sections: Vec<(String, String)> = Vec::new();
    let mut inserted = false;
    for (heading, content) in sections {
        if !inserted && heading_to_key(&heading) == Some(section_key) {
            let mut new_content = content.trim_end().to_string();
            for f in &to_add {
                new_content.push_str(&format!("\n- {}", f));
            }
            out_sections.push((heading, new_content.trim_start().to_string()));
            inserted = true;
        } else {
            out_sections.push((heading, content));
        }
    }
    if !inserted {
        // Section absente (supprimée par l'utilisateur, ou note pas encore au
        // template — cas défensif) — recréée en fin de note. Titre dans la
        // langue déjà utilisée par les AUTRES sections de la note quand on
        // peut la déduire, sinon `app_language` (repli, rare en pratique).
        let existing_lang = sections_language_hint(&out_sections).unwrap_or("fr");
        let heading = key_to_heading(section_key, existing_lang).to_string();
        let content: String = to_add.iter().map(|f| format!("- {}\n", f)).collect::<String>().trim_end().to_string();
        out_sections.push((heading, content));
    }

    let mut rebuilt = preamble.trim_end().to_string();
    for (heading, content) in &out_sections {
        rebuilt.push_str(&format!("\n\n## {}\n\n{}", heading, content.trim()));
    }
    let new_body = format!("{}\n", rebuilt.trim_start_matches('\n'));

    let content = frontmatter::serialize(&metadata, &new_body);
    tokio::fs::write(path, content).await?;
    Ok(to_add.len())
}

/// Best-effort guess of which language a project note's existing headings are
/// written in (looks for the first heading that matches an EN title) — used
/// only to pick a consistent language when RE-adding a section the user
/// deleted; never rewrites existing headings.
fn sections_language_hint(sections: &[(String, String)]) -> Option<&'static str> {
    sections.iter().find_map(|(h, _)| {
        let h = h.trim();
        section_table().into_iter().find(|(_, _, en)| h.eq_ignore_ascii_case(en)).map(|_| "en")
    })
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

/// Écrit `facts` (chacun accompagné de sa section, `SECTION_KEYS`) dans la
/// note de contexte de ce projet (créée lazily — avec reconstruction
/// rétroactive au besoin, spec/16b §4). Point d'entrée utilisé par
/// `finalize_ingestion`/`route_email_context_additions` pour router les
/// `context_addition` à `scope: "project"` (spec/16b §3). Retourne le nombre
/// de faits effectivement ajoutés (dédupliqués contre l'existant).
pub async fn write_project_context_fact(
    vault_root: &Path,
    db: &SqlitePool,
    project: &str,
    facts: &[(String, String)],
) -> Result<usize> {
    let clean: Vec<(String, String)> = facts
        .iter()
        .map(|(section, fact)| (section.trim().to_string(), fact.trim().to_string()))
        .filter(|(_, fact)| !fact.is_empty())
        .collect();
    if clean.is_empty() {
        return Ok(0);
    }

    let (path, just_created) = get_or_create_project_context_note(vault_root, db, project).await?;
    if just_created {
        if let Err(e) = build_project_context_retroactive(vault_root, db, project, &path).await {
            eprintln!("[project_context] retroactive build failed for {}: {}", project, e);
        }
    }

    let mut by_section: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for (section, fact) in clean {
        let key = if SECTION_KEYS.contains(&section.as_str()) { section } else { SECTION_KEYS[0].to_string() };
        by_section.entry(key).or_default().push(fact);
    }

    let mut total = 0;
    for (key, facts) in by_section {
        total += append_facts_to_section(&path, &key, &facts).await?;
    }
    Ok(total)
}

/// Fusionne le projet `source` dans `target` (spec/07/16b — nettoyage des
/// quasi-doublons créés par une extraction qui a inventé un nom légèrement
/// différent) : re-tague toutes les notes du vault (frontmatter `project`),
/// fusionne les deux notes de contexte section par section (dédupliqué), et
/// renomme le marqueur `+Projet` de toutes les tâches de `Todo.md`. Action
/// explicite et manuelle (pas d'auto-fusion silencieuse) — déclenchée depuis
/// la vue Projets (clic droit → « Fusionner avec… »). Retourne le nombre de
/// notes retaguées.
pub async fn merge_projects(vault_root: &Path, db: &SqlitePool, source: &str, target: &str) -> Result<usize> {
    let source = source.trim();
    let target = target.trim();
    if source.is_empty() || target.is_empty() || source == target {
        return Ok(0);
    }

    let intelligence = vault_root.join(crate::ai::intelligence_folder(db).await);
    let source_context_path = find_project_context_note(&intelligence, source);

    // 1. Toutes les notes (hors notes de contexte, traitées séparément
    //    ci-dessous) qui portaient `source` dans leur `project` → `target`.
    let notes = super::vault::list_notes_with_project(vault_root)?;
    let mut retagged = 0usize;
    for n in notes {
        if n.note_type == "context" || !n.project.iter().any(|p| p == source) {
            continue;
        }
        let path = PathBuf::from(&n.path);
        let mut note = super::vault::get_note_file(&path).await?;
        let mut project: Vec<String> = note
            .metadata
            .project
            .iter()
            .map(|p| if p == source { target.to_string() } else { p.clone() })
            .collect();
        project.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
        note.metadata.project = project;
        super::vault::update_note_file(&path, note.metadata, &note.body).await?;
        retagged += 1;
    }

    // 2. Notes de contexte : fusionne le contenu de `source` dans `target`
    //    (créé si besoin), section par section, puis supprime la note source.
    if let Some(source_path) = source_context_path {
        let raw = tokio::fs::read_to_string(&source_path).await?;
        let stem = source_path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let (_, source_body) = frontmatter::parse(&raw, &stem);
        let (_, source_sections) = split_sections(&source_body);

        let (target_path, just_created) = get_or_create_project_context_note(vault_root, db, target).await?;
        if just_created {
            if let Err(e) = build_project_context_retroactive(vault_root, db, target, &target_path).await {
                eprintln!("[project_context] retroactive build failed for {}: {}", target, e);
            }
        }

        for (heading, content) in source_sections {
            let Some(key) = heading_to_key(&heading) else { continue };
            let facts: Vec<String> = content
                .lines()
                .filter_map(|l| l.trim().strip_prefix("- "))
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            if !facts.is_empty() {
                append_facts_to_section(&target_path, key, &facts).await?;
            }
        }

        if source_path != target_path {
            tokio::fs::remove_file(&source_path).await.ok();
        }
    }

    // 3. `Todo.md` : renomme le marqueur `+Projet` de toutes les tâches
    //    taguées `source`.
    let todo_rel_path = crate::todos::todo_file_path(db).await;
    let todo_path = vault_root.join(&todo_rel_path);
    if let Ok(content) = tokio::fs::read_to_string(&todo_path).await {
        let tasks = super::todo_md::parse_all(&content);
        let mut updated = content.clone();
        for task in tasks.iter().filter(|t| t.fields.project.as_deref() == Some(source)) {
            let id = super::todo_md::normalize_title(&task.fields.titre);
            let mut patch = task.fields.clone();
            patch.project = Some(target.to_string());
            updated = super::todo_md::edit_task(&updated, &id, &patch)?;
        }
        if updated != content {
            tokio::fs::write(&todo_path, updated).await?;
        }
    }

    Ok(retagged)
}

/// Supprime `project` de toutes les notes/tâches qui le référencent, SANS le
/// fusionner ailleurs (spec/07 « Supprimer le projet », même menu que
/// « Fusionner avec… » sur la vue Projets) : retire la valeur de la liste
/// `project` de chaque note (une note qui n'avait que celui-ci retombe dans
/// « Sans projet », comme toute note isolée), retire le marqueur `+Projet`
/// des tâches `Todo.md` concernées, et supprime la note de contexte du projet
/// si elle existe. Retourne le nombre de notes retaguées.
pub async fn delete_project(vault_root: &Path, db: &SqlitePool, project: &str) -> Result<usize> {
    let project = project.trim();
    if project.is_empty() {
        return Ok(0);
    }

    let intelligence = vault_root.join(crate::ai::intelligence_folder(db).await);
    if let Some(context_path) = find_project_context_note(&intelligence, project) {
        tokio::fs::remove_file(&context_path).await.ok();
    }

    let notes = super::vault::list_notes_with_project(vault_root)?;
    let mut updated = 0usize;
    for n in notes {
        if n.note_type == "context" || !n.project.iter().any(|p| p == project) {
            continue;
        }
        let path = PathBuf::from(&n.path);
        let mut note = super::vault::get_note_file(&path).await?;
        note.metadata.project.retain(|p| p != project);
        super::vault::update_note_file(&path, note.metadata, &note.body).await?;
        updated += 1;
    }

    let todo_rel_path = crate::todos::todo_file_path(db).await;
    let todo_path = vault_root.join(&todo_rel_path);
    if let Ok(content) = tokio::fs::read_to_string(&todo_path).await {
        let tasks = super::todo_md::parse_all(&content);
        let mut updated_content = content.clone();
        for task in tasks.iter().filter(|t| t.fields.project.as_deref() == Some(project)) {
            let id = super::todo_md::normalize_title(&task.fields.titre);
            let mut patch = task.fields.clone();
            patch.project = None;
            updated_content = super::todo_md::edit_task(&updated_content, &id, &patch)?;
        }
        if updated_content != content {
            tokio::fs::write(&todo_path, updated_content).await?;
        }
    }

    Ok(updated)
}
