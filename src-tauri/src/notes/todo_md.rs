//! `Todo.md` reader/writer (spec/06) — THE todos source of truth.
//!
//! Two layers:
//! - append/merge used by the merged ingestion (spec/05): deduped tasks into
//!   `## À faire`;
//! - full parse + line mutations (check, archive, edit) used by the `todos`
//!   module now that the SQLite table is gone.
//!
//! Tasks have no stored id: identity is the **normalized title** (spec/06 dedups
//! on it file-wide, so it's unique by construction).

use anyhow::{anyhow, Result};
use std::path::Path;

/// One task extracted by the ingestion AI call (spec/05's `taches[]`).
#[derive(Debug, Clone)]
pub struct IngestTask {
    pub titre: String,
    pub responsable: Option<String>,
    pub echeance: Option<String>,
}

/// Section order mandated by spec/06. New tasks always land in "À faire".
const SECTIONS: [&str; 4] = ["Prioritaire", "En cours", "À faire", "Archivé"];
const TARGET_SECTION: &str = "À faire";

/// Lowercase + collapse whitespace, for cross-section dedup (spec/06).
pub fn normalize_title(s: &str) -> String {
    s.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Render one task as a checkbox line: `- [ ] Titre — @Resp — 📅 date`.
fn render_line(task: &IngestTask) -> String {
    let mut line = format!("- [ ] {}", task.titre);
    if let Some(ref r) = task.responsable {
        if !r.trim().is_empty() {
            line.push_str(&format!(" — @{}", r.trim()));
        }
    }
    if let Some(ref d) = task.echeance {
        if !d.trim().is_empty() {
            line.push_str(&format!(" — 📅 {}", d.trim()));
        }
    }
    line
}

/// Extract the normalized title from an existing checkbox line
/// (`- [ ] Titre — @Resp — 📅 date` → "titre").
fn title_from_line(line: &str) -> Option<String> {
    let rest = line.trim_start().strip_prefix("- [ ]").or_else(|| line.trim_start().strip_prefix("- [x]"))?;
    let title = rest.split(" — ").next().unwrap_or(rest).trim();
    if title.is_empty() { None } else { Some(normalize_title(title)) }
}

/// Merge `tasks` into `existing` content (spec/06 format), appending non-duplicate
/// tasks (by normalized title, across the whole file) to `## À faire`. Returns
/// the new full file content and how many tasks were actually added.
pub fn merge_tasks(existing: Option<&str>, tasks: &[IngestTask]) -> (String, usize) {
    // section name -> lines already in that section (in original order).
    let mut sections: Vec<(String, Vec<String>)> =
        SECTIONS.iter().map(|s| (s.to_string(), Vec::new())).collect();

    if let Some(content) = existing {
        let mut current: Option<usize> = None;
        for raw_line in content.lines() {
            let trimmed = raw_line.trim_end();
            if let Some(name) = trimmed.trim().strip_prefix("## ") {
                let name = name.trim();
                current = match sections.iter().position(|(s, _)| s == name) {
                    Some(idx) => Some(idx),
                    None => {
                        // Unknown section — preserve it verbatim, appended at the end.
                        sections.push((name.to_string(), Vec::new()));
                        Some(sections.len() - 1)
                    }
                };
                continue;
            }
            if let Some(idx) = current {
                sections[idx].1.push(trimmed.to_string());
            }
            // Lines before the first "## " header (if any) are dropped — spec/06
            // has no frontmatter/preamble for Todo.md.
        }
    }

    let seen: std::collections::HashSet<String> = sections
        .iter()
        .flat_map(|(_, lines)| lines.iter())
        .filter_map(|l| title_from_line(l))
        .collect();

    let target_idx = sections.iter().position(|(s, _)| s == TARGET_SECTION).expect("À faire section always present");

    let mut added = 0;
    for task in tasks {
        let norm = normalize_title(&task.titre);
        if norm.is_empty() || seen.contains(&norm) {
            continue;
        }
        sections[target_idx].1.push(render_line(task));
        added += 1;
    }

    let mut out = String::new();
    for (name, lines) in &sections {
        out.push_str(&format!("## {}\n", name));
        for line in lines {
            if !line.trim().is_empty() {
                out.push_str(line);
                out.push('\n');
            }
        }
        out.push('\n');
    }

    (out.trim_end().to_string() + "\n", added)
}

/// Read `{vault_root}/{todo_rel_path}` (missing file = empty doc), merge `tasks`
/// into it, and write the result back. Returns how many tasks were added.
pub async fn append_tasks(vault_root: &Path, todo_rel_path: &str, tasks: &[IngestTask]) -> Result<usize> {
    if tasks.is_empty() {
        return Ok(0);
    }

    let path = vault_root.join(todo_rel_path);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let existing = tokio::fs::read_to_string(&path).await.ok();
    let (new_content, added) = merge_tasks(existing.as_deref(), tasks);

    if added > 0 {
        tokio::fs::write(&path, new_content).await?;
    }

    Ok(added)
}

// ─── Full parse + line mutations (spec/06 lifecycle) ────────────────────────────

/// One parsed task line, with enough context to display and to mutate it.
#[derive(Debug, Clone)]
pub struct ParsedTask {
    pub section: String,
    pub titre: String,
    pub responsable: Option<String>,
    pub echeance: Option<String>,
    pub checked: bool,
}

fn parse_line(line: &str) -> Option<(bool, IngestTask)> {
    let trimmed = line.trim_start();
    let (checked, rest) = if let Some(r) = trimmed.strip_prefix("- [ ]") {
        (false, r)
    } else if let Some(r) = trimmed.strip_prefix("- [x]").or_else(|| trimmed.strip_prefix("- [X]")) {
        (true, r)
    } else {
        return None;
    };

    let mut titre = rest.trim().to_string();
    let mut responsable = None;
    let mut echeance = None;
    // Fields are " — "-separated: `Titre — @Resp — 📅 date` (render_line's format).
    let parts: Vec<&str> = rest.split(" — ").map(|p| p.trim()).collect();
    if parts.len() > 1 {
        titre = parts[0].to_string();
        for part in &parts[1..] {
            if let Some(r) = part.strip_prefix('@') {
                responsable = Some(r.trim().to_string());
            } else if let Some(d) = part.strip_prefix("📅") {
                echeance = Some(d.trim().to_string());
            }
        }
    }

    if titre.is_empty() {
        return None;
    }
    Some((checked, IngestTask { titre, responsable, echeance }))
}

/// Every task in the file, in order, tagged with the `## Section` it sits under.
pub fn parse_all(content: &str) -> Vec<ParsedTask> {
    let mut section = String::new();
    let mut out = Vec::new();
    for line in content.lines() {
        if let Some(name) = line.trim().strip_prefix("## ") {
            section = name.trim().to_string();
            continue;
        }
        if let Some((checked, task)) = parse_line(line) {
            out.push(ParsedTask {
                section: section.clone(),
                titre: task.titre,
                responsable: task.responsable,
                echeance: task.echeance,
                checked,
            });
        }
    }
    out
}

/// Apply `f` to the single task line whose normalized title matches `id`.
/// Returns the new content, or an error if no such task exists.
fn map_task_line(content: &str, id: &str, mut f: impl FnMut(&str, bool, &IngestTask) -> Option<String>) -> Result<String> {
    let mut lines: Vec<Option<String>> = content.lines().map(|l| Some(l.to_string())).collect();
    let mut found = false;

    for slot in lines.iter_mut() {
        let line = slot.as_ref().unwrap().clone();
        if let Some((checked, task)) = parse_line(&line) {
            if normalize_title(&task.titre) == id {
                *slot = f(&line, checked, &task);
                found = true;
                break;
            }
        }
    }

    if !found {
        return Err(anyhow!("Tâche introuvable dans Todo.md : {id}"));
    }

    let mut out = String::new();
    for slot in lines.into_iter().flatten() {
        out.push_str(&slot);
        out.push('\n');
    }
    Ok(out)
}

/// Check / uncheck a task in place (spec/06: done stays where it is).
pub fn set_checked(content: &str, id: &str, checked: bool) -> Result<String> {
    map_task_line(content, id, |_, _, task| {
        let rendered = render_line(task);
        Some(if checked {
            rendered.replacen("- [ ]", "- [x]", 1)
        } else {
            rendered
        })
    })
}

/// Move a task to `## Archivé` (spec/06 "archiver" — nothing is ever deleted).
pub fn archive_task(content: &str, id: &str) -> Result<String> {
    let mut archived_line: Option<(bool, IngestTask)> = None;
    let without = map_task_line(content, id, |_, checked, task| {
        archived_line = Some((checked, task.clone()));
        None // drop the line from its current section
    })?;

    let (checked, task) = archived_line.expect("map_task_line found the task");
    let mut line = render_line(&task);
    if checked {
        line = line.replacen("- [ ]", "- [x]", 1);
    }

    // Re-parse sections and append to Archivé (created by merge_tasks if absent).
    let (mut out, _) = merge_tasks(Some(&without), &[]);
    if let Some(pos) = out.find("## Archivé") {
        let insert_at = out[pos..].find('\n').map(|i| pos + i + 1).unwrap_or(out.len());
        out.insert_str(insert_at, &format!("{}\n", line));
    }
    Ok(out)
}

/// Déplace une tâche vers `## section`, à `position` (index 0-based dans la
/// section ; hors bornes / absent → fin de section). Conserve `@responsable`,
/// `📅 échéance` et l'état coché (spec/06 — Kanban : colonne = section, ordre =
/// ordre des lignes). La section cible est créée si absente (sections inconnues
/// préservées par `merge_tasks`).
pub fn move_task(content: &str, id: &str, section: &str, position: Option<usize>) -> Result<String> {
    let section = section.trim();
    if section.is_empty() {
        return Err(anyhow!("Section cible vide"));
    }

    // 1. Retirer la ligne de sa section actuelle (en mémorisant son rendu exact).
    let mut moved: Option<(bool, IngestTask)> = None;
    let without = map_task_line(content, id, |_, checked, task| {
        moved = Some((checked, task.clone()));
        None
    })?;
    let (checked, task) = moved.expect("map_task_line found the task");
    let mut line = render_line(&task);
    if checked {
        line = line.replacen("- [ ]", "- [x]", 1);
    }

    // 2. Normaliser les sections (squelette garanti), puis insérer dans la cible.
    let (normalized, _) = merge_tasks(Some(&without), &[]);
    let heading = format!("## {}", section);
    let mut out: Vec<String> = Vec::new();
    let mut inserted = false;
    let mut in_target = false;
    let mut task_index = 0usize;

    for l in normalized.lines() {
        let is_heading = l.trim().starts_with("## ");
        if is_heading {
            // On quitte la section cible sans avoir inséré → fin de section.
            if in_target && !inserted {
                // Insère avant les lignes vides de fin de section.
                while out.last().map(|s| s.trim().is_empty()).unwrap_or(false) {
                    out.pop();
                }
                out.push(line.clone());
                out.push(String::new());
                inserted = true;
            }
            in_target = l.trim() == heading;
            task_index = 0;
        } else if in_target && !inserted && parse_line(l).is_some() {
            if position.map(|p| task_index >= p).unwrap_or(false) {
                out.push(line.clone());
                inserted = true;
            }
            task_index += 1;
        }
        out.push(l.to_string());
    }
    if in_target && !inserted {
        out.push(line.clone());
        inserted = true;
    }
    if !inserted {
        // Section inconnue du fichier → on la crée en fin (avant rien).
        out.push(String::new());
        out.push(heading);
        out.push(line);
    }

    Ok(out.join("\n").trim_end().to_string() + "\n")
}

/// Rewrite a task's title / responsable / échéance (keeps its checked state + place).
pub fn edit_task(content: &str, id: &str, new_task: &IngestTask) -> Result<String> {
    map_task_line(content, id, |_, checked, _| {
        let mut line = render_line(new_task);
        if checked {
            line = line.replacen("- [ ]", "- [x]", 1);
        }
        Some(line)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(titre: &str, responsable: Option<&str>, echeance: Option<&str>) -> IngestTask {
        IngestTask {
            titre: titre.to_string(),
            responsable: responsable.map(|s| s.to_string()),
            echeance: echeance.map(|s| s.to_string()),
        }
    }

    #[test]
    fn creates_skeleton_when_missing() {
        let (out, added) = merge_tasks(None, &[task("Relire le contrat", Some("Jean"), Some("2026-07-10"))]);
        assert_eq!(added, 1);
        assert!(out.contains("## Prioritaire\n"));
        assert!(out.contains("## À faire\n"));
        assert!(out.contains("- [ ] Relire le contrat — @Jean — 📅 2026-07-10"));
        assert!(out.contains("## Archivé\n"));
    }

    #[test]
    fn dedups_across_sections_by_normalized_title() {
        let existing = "## Prioritaire\n- [ ] Relire   le contrat — @Jean\n\n## En cours\n\n## À faire\n\n## Archivé\n";
        let (out, added) = merge_tasks(Some(existing), &[task("relire le contrat", None, None)]);
        assert_eq!(added, 0);
        assert_eq!(out.matches("relire le contrat").count() + out.matches("Relire   le contrat").count(), 1);
    }

    #[test]
    fn parses_fields_and_sections() {
        let content = "## Prioritaire\n- [ ] Relire le contrat — @Jean — 📅 2026-07-10\n\n## À faire\n- [x] Vieille tâche\n";
        let tasks = parse_all(content);
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].section, "Prioritaire");
        assert_eq!(tasks[0].titre, "Relire le contrat");
        assert_eq!(tasks[0].responsable.as_deref(), Some("Jean"));
        assert_eq!(tasks[0].echeance.as_deref(), Some("2026-07-10"));
        assert!(!tasks[0].checked);
        assert!(tasks[1].checked);
    }

    #[test]
    fn checks_and_unchecks_in_place() {
        let content = "## À faire\n- [ ] Relire le contrat — @Jean\n";
        let done = set_checked(content, &normalize_title("Relire le contrat"), true).unwrap();
        assert!(done.contains("- [x] Relire le contrat — @Jean"));
        let undone = set_checked(&done, &normalize_title("Relire le contrat"), false).unwrap();
        assert!(undone.contains("- [ ] Relire le contrat — @Jean"));
    }

    #[test]
    fn archives_to_archive_section() {
        let content = "## Prioritaire\n- [ ] Relire le contrat\n\n## Archivé\n- [ ] Déjà là\n";
        let out = archive_task(content, &normalize_title("Relire le contrat")).unwrap();
        let archive_pos = out.find("## Archivé").unwrap();
        let task_pos = out.find("- [ ] Relire le contrat").unwrap();
        assert!(task_pos > archive_pos, "task should now live under Archivé:\n{out}");
        assert!(out.contains("- [ ] Déjà là"));
    }

    #[test]
    fn edits_title_and_fields() {
        let content = "## À faire\n- [x] Vieille formulation — @Jean\n";
        let out = edit_task(
            content,
            &normalize_title("Vieille formulation"),
            &task("Nouvelle formulation", None, Some("2026-08-01")),
        )
        .unwrap();
        assert!(out.contains("- [x] Nouvelle formulation — 📅 2026-08-01"));
        assert!(!out.contains("Vieille formulation"));
    }

    #[test]
    fn moves_between_sections_keeping_fields() {
        let content = "## Prioritaire\n\n## En cours\n\n## À faire\n- [x] Relire le contrat — @Jean — 📅 2026-07-10\n- [ ] Autre tâche\n\n## Archivé\n";
        let out = move_task(content, &normalize_title("Relire le contrat"), "En cours", None).unwrap();
        let en_cours = out.find("## En cours").unwrap();
        let a_faire = out.find("## À faire").unwrap();
        let pos = out.find("- [x] Relire le contrat — @Jean — 📅 2026-07-10").unwrap();
        assert!(pos > en_cours && pos < a_faire, "task should sit under En cours:\n{out}");
        assert!(out.contains("- [ ] Autre tâche"));
    }

    #[test]
    fn moves_to_position_within_section() {
        let content = "## Prioritaire\n- [ ] A\n- [ ] B\n\n## À faire\n- [ ] C\n";
        let out = move_task(content, &normalize_title("C"), "Prioritaire", Some(1)).unwrap();
        let a = out.find("- [ ] A").unwrap();
        let b = out.find("- [ ] B").unwrap();
        let c = out.find("- [ ] C").unwrap();
        assert!(a < c && c < b, "C should be between A and B:\n{out}");
    }

    #[test]
    fn move_to_same_section_reorders() {
        let content = "## À faire\n- [ ] A\n- [ ] B\n- [ ] C\n";
        let out = move_task(content, &normalize_title("C"), "À faire", Some(0)).unwrap();
        let a = out.find("- [ ] A").unwrap();
        let c = out.find("- [ ] C").unwrap();
        assert!(c < a, "C should now be first:\n{out}");
    }

    #[test]
    fn unknown_id_errors() {
        let content = "## À faire\n- [ ] Une tâche\n";
        assert!(set_checked(content, "inexistante", true).is_err());
    }

    #[test]
    fn preserves_existing_lines_and_unknown_sections() {
        let existing = "## Prioritaire\n- [x] Déjà fait\n\n## En cours\n\n## À faire\n- [ ] Ancienne tâche\n\n## Archivé\n\n## Notes perso\n- pense-bête\n";
        let (out, added) = merge_tasks(Some(existing), &[task("Nouvelle tâche", None, None)]);
        assert_eq!(added, 1);
        assert!(out.contains("- [x] Déjà fait"));
        assert!(out.contains("- [ ] Ancienne tâche"));
        assert!(out.contains("- [ ] Nouvelle tâche"));
        assert!(out.contains("## Notes perso"));
        assert!(out.contains("- pense-bête"));
    }
}
