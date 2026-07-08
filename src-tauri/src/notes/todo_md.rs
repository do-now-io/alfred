//! `Todo.md` reader/writer (spec/06) — used by the merged ingestion (spec/05) to
//! append AI-extracted tasks to the vault's to-do file.
//!
//! This is intentionally narrow: it only *appends deduped tasks to `## À faire`*.
//! It does not implement the full spec/06 refonte (the Tâches screen still reads
//! SQLite today — ingestion dual-writes to both, see ai::run_ingestion_core).

use anyhow::Result;
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
