//! `Todo.md` reader/writer (spec/06) — THE todos source of truth.
//!
//! Two layers:
//! - append/merge used by the merged ingestion (spec/05): deduped tasks into
//!   `## À faire`;
//! - full parse + line mutations (check, archive, edit, move) used by the
//!   `todos` module now that the SQLite table is gone.
//!
//! Tasks have no stored id: identity is the **normalized title** (spec/06 dedups
//! on it file-wide, so it's unique by construction).
//!
//! **Fiche tâche (spec/06 2e passe)** : au-delà du titre/@responsable/📅échéance,
//! une tâche peut porter des champs inline supplémentaires sur sa ligne
//! (`+Projet`, `!priorité`, `⏱estimation`, provenance `[[Note source]] (date)`)
//! et un **bloc indenté** en dessous (sous-puces libres `  - ...` + description
//! longue `  > ...`). Tout reste compatible Obsidian — pas de frontmatter par
//! tâche, uniquement des marqueurs inline + de l'indentation Markdown standard.

use anyhow::{anyhow, Result};
use std::path::Path;

/// One task extracted by the ingestion AI call (spec/05's `taches[]`) — the
/// minimal shape Claude produces. Richer fields (project/priority/estimate/
/// provenance) are stamped separately (see `merge_tasks`'s `provenance` arg).
#[derive(Debug, Clone)]
pub struct IngestTask {
    pub titre: String,
    pub responsable: Option<String>,
    pub echeance: Option<String>,
    /// Projet du compte-rendu source (spec/06) : posé en marqueur `+Projet`
    /// sur la ligne, pour que le filtre projet du Kanban couvre les tâches
    /// extraites par l'ingestion sans tagage manuel.
    pub project: Option<String>,
    /// Provenance mail (spec/24 §3) — texte déjà formaté `✉️ <objet> (<date>)`,
    /// posé PAR TÂCHE (contrairement au `provenance` partagé de `merge_tasks`/
    /// `append_tasks` : un batch d'e-mails mélange plusieurs mails, chacun avec
    /// son propre objet/date). Mutuellement exclusif avec le `provenance`
    /// wikilink des comptes-rendus — jamais les deux sur une même tâche.
    pub email_provenance: Option<String>,
}

/// The full set of fields a task LINE can carry (spec/06 2e passe). Sub-bullets
/// and description live in the task's trailing indented block, not here (see
/// `TaskBlock`).
#[derive(Debug, Clone, Default)]
pub struct TaskFields {
    pub titre: String,
    pub responsable: Option<String>,
    pub echeance: Option<String>,
    /// `+Projet` — un seul projet par tâche (marqueur inline, spec/06).
    pub project: Option<String>,
    /// `!haute` / `!moyenne` / `!basse`.
    pub priority: Option<String>,
    /// `⏱2h` — texte libre.
    pub estimate: Option<String>,
    /// Provenance (spec/05/06) : titre du compte-rendu source — système, jamais
    /// édité par l'utilisateur (préservé automatiquement lors des éditions).
    pub source_note: Option<String>,
    /// Provenance : date de la note source (YYYY-MM-DD).
    pub source_date: Option<String>,
    /// Provenance mail (spec/24 §3) — texte déjà formaté `✉️ <objet> (<date>)`,
    /// non cliquable (pas de note/wikilink derrière un mail). Mutuellement
    /// exclusif avec `source_note`/`source_date`.
    pub email_provenance: Option<String>,
}

impl From<&IngestTask> for TaskFields {
    fn from(t: &IngestTask) -> Self {
        TaskFields {
            titre: t.titre.clone(),
            responsable: t.responsable.clone(),
            echeance: t.echeance.clone(),
            project: t.project.clone(),
            email_provenance: t.email_provenance.clone(),
            ..Default::default()
        }
    }
}

/// Le bloc indenté sous une ligne de tâche (spec/06 2e passe « fiche tâche »).
#[derive(Debug, Clone, Default)]
pub struct TaskBlock {
    /// Description longue — un paragraphe par ligne (`  > ...`).
    pub description: Vec<String>,
    /// Sous-puces libres / mini-checklist (`  - ...`).
    pub notes: Vec<String>,
}

/// Section order mandated by spec/06 (v2 — `Prioritaire` retirée, `Fait`
/// ajoutée : cocher une tâche la déplace dans `Fait`, ce n'est plus un simple
/// marqueur en place). New tasks always land in "À faire". Ces 4 libellés
/// restent la représentation **interne** (FR) — inchangée pour ne rien casser
/// côté tests/logique existants. `SECTIONS_EN` n'est là que pour la
/// RECONNAISSANCE (spec/21) : un en-tête déjà écrit en anglais (ou dans un
/// vault dont l'UI est passée en anglais) doit toujours retomber dans le même
/// compartiment plutôt que de créer une section "inconnue" en double.
/// L'écriture de nouvelles sections reste en français pour l'instant (📝 —
/// voir spec/21 §Contenu généré, non traité dans ce lot).
const SECTIONS: [&str; 4] = ["À faire", "En cours", "Fait", "Archivé"];
const SECTIONS_EN: [&str; 4] = ["To Do", "In Progress", "Done", "Archived"];
const TARGET_SECTION: &str = "À faire";
const NO_PROJECT_FR: &str = "Sans projet";
const NO_PROJECT_EN: &str = "No project";
/// Nom interne de la section « fait » (spec/06 v2) — cocher/décocher une
/// tâche revient à la déplacer entre `TARGET_SECTION` et cette section.
const DONE_SECTION: &str = "Fait";

/// Reconnaît un en-tête `## ...` en FR **ou** EN et renvoie son équivalent FR
/// canonique (la représentation interne) — `None` si ce n'est pas l'une des 4
/// sections stables (section perso de l'utilisateur, préservée telle quelle).
fn canonical_section(name: &str) -> Option<&'static str> {
    let name = name.trim();
    SECTIONS.iter().position(|s| s.eq_ignore_ascii_case(name))
        .or_else(|| SECTIONS_EN.iter().position(|s| s.eq_ignore_ascii_case(name)))
        .map(|i| SECTIONS[i])
}

/// Libellé d'écriture d'une section canonique (FR interne), localisé selon
/// `app_language` (spec/21, feedback tests) : le fichier prend enfin la
/// langue de l'appli à l'écriture, pas seulement à la reconnaissance en
/// lecture (`canonical_section`/`SECTIONS_EN` ci-dessus). Une section perso
/// (non reconnue) est renvoyée telle quelle, jamais traduite.
pub(crate) fn section_label(canonical: &str, lang: &str) -> String {
    if lang == "en" {
        if let Some(i) = SECTIONS.iter().position(|s| *s == canonical) {
            return SECTIONS_EN[i].to_string();
        }
    }
    canonical.to_string()
}

/// Libellé du groupe « sans projet » (spec/06 structuration), localisé comme
/// `section_label`.
fn no_project_label(lang: &str) -> &'static str {
    if lang == "en" { NO_PROJECT_EN } else { NO_PROJECT_FR }
}

/// Alias de migration (spec/06 v2) : anciens en-têtes **retirés** → section
/// d'accueil actuelle. Distinct de `canonical_section` (qui ne reconnaît que
/// les 4 sections stables ACTUELLES) — celui-ci absorbe les fichiers écrits
/// avant le retrait de `Prioritaire` sans dupliquer une section "inconnue".
fn migration_alias(name: &str) -> Option<&'static str> {
    let name = name.trim();
    if name.eq_ignore_ascii_case("Prioritaire") || name.eq_ignore_ascii_case("Priority") {
        Some(TARGET_SECTION)
    } else {
        None
    }
}

const VALID_PRIORITIES: [&str; 3] = ["haute", "moyenne", "basse"];

/// Lowercase + collapse whitespace, for cross-section dedup (spec/06).
pub fn normalize_title(s: &str) -> String {
    s.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Render one task as a checkbox line — spec/06 2e passe field order:
/// `- [ ] Titre — @Resp — 📅 date — +Projet — !priorité — ⏱estimation — [[source]] (date source)`.
fn render_line(fields: &TaskFields) -> String {
    let mut line = format!("- [ ] {}", fields.titre);
    if let Some(ref r) = fields.responsable {
        if !r.trim().is_empty() {
            line.push_str(&format!(" — @{}", r.trim()));
        }
    }
    if let Some(ref d) = fields.echeance {
        if !d.trim().is_empty() {
            line.push_str(&format!(" — 📅 {}", d.trim()));
        }
    }
    if let Some(ref p) = fields.project {
        if !p.trim().is_empty() {
            line.push_str(&format!(" — +{}", p.trim()));
        }
    }
    if let Some(ref p) = fields.priority {
        let p = p.trim().to_lowercase();
        if VALID_PRIORITIES.contains(&p.as_str()) {
            line.push_str(&format!(" — !{}", p));
        }
    }
    if let Some(ref e) = fields.estimate {
        if !e.trim().is_empty() {
            line.push_str(&format!(" — ⏱{}", e.trim()));
        }
    }
    if let Some(ref note) = fields.source_note {
        if !note.trim().is_empty() {
            match fields.source_date.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                Some(date) => line.push_str(&format!(" — [[{}]] ({})", note.trim(), date)),
                None => line.push_str(&format!(" — [[{}]]", note.trim())),
            }
        }
    } else if let Some(ref email) = fields.email_provenance {
        // Texte brut, JAMAIS un wikilink (spec/24 §3) : il n'y a rien à ouvrir
        // dans le vault derrière un mail.
        if !email.trim().is_empty() {
            line.push_str(&format!(" — {}", email.trim()));
        }
    }
    line
}

/// Extrait la provenance `[[Note]] (date)` en FIN de ligne (regex maison, pas de
/// dépendance) et renvoie `(reste_du_texte, source_note, source_date)`. Traité
/// à part du split " — " général : le titre d'un compte-rendu (nommé par sujet,
/// spec/05/07) peut lui-même contenir " — ", ce qui rendrait un split naïf ambigu.
fn extract_provenance(rest: &str) -> (String, Option<String>, Option<String>) {
    let Some(idx) = rest.rfind("[[") else { return (rest.to_string(), None, None) };
    let Some(rel_end) = rest[idx..].find("]]") else { return (rest.to_string(), None, None) };
    let close = idx + rel_end + 2;
    // The wikilink must be a trailing token (only trailing whitespace/date after it).
    let target = rest[idx + 2..idx + rel_end].trim().to_string();
    if target.is_empty() {
        return (rest.to_string(), None, None);
    }

    let after = rest[close..].trim_start();
    let mut date = None;
    let mut consumed_after = 0usize;
    if let Some(rest2) = after.strip_prefix('(') {
        if let Some(cend) = rest2.find(')') {
            let candidate = rest2[..cend].trim();
            if !candidate.is_empty() {
                date = Some(candidate.to_string());
                consumed_after = 1 + cend + 1;
            }
        }
    }
    if !after[consumed_after..].trim().is_empty() {
        // Trailing garbage after the wikilink/date — not a provenance suffix
        // after all, leave the line untouched (safer than mis-parsing).
        return (rest.to_string(), None, None);
    }

    let mut before = rest[..idx].to_string();
    for sep in [" — ", " - "] {
        if before.ends_with(sep) {
            before.truncate(before.len() - sep.len());
            break;
        }
    }
    (before, Some(target), date)
}

/// Extrait la provenance mail `✉️ <objet> (<date>)` en FIN de ligne (spec/24
/// §3) — texte brut, jamais un wikilink. Ne s'applique que si
/// `extract_provenance` n'a rien trouvé (mutuellement exclusif). Repère le `✉️`
/// le plus à droite et prend tout le reste comme provenance, sur le même
/// principe que `extract_provenance` (l'objet du mail peut lui-même contenir
/// " — ").
fn extract_email_provenance(rest: &str) -> (String, Option<String>) {
    let Some(idx) = rest.rfind('✉') else { return (rest.to_string(), None) };
    let email_text = rest[idx..].trim().to_string();
    if email_text.is_empty() {
        return (rest.to_string(), None);
    }
    let mut before = rest[..idx].to_string();
    for sep in [" — ", " - "] {
        if before.ends_with(sep) {
            before.truncate(before.len() - sep.len());
            break;
        }
    }
    (before, Some(email_text))
}

/// Parse one checkbox line into `(checked, TaskFields)`. Requires the line to
/// start at column 0 (indented lines belong to a task's trailing block, not a
/// new task — see `is_task_checkbox_line`).
fn parse_line(line: &str) -> Option<(bool, TaskFields)> {
    if !is_task_checkbox_line(line) {
        return None;
    }
    let trimmed = line.trim_start();
    let (checked, rest) = if let Some(r) = trimmed.strip_prefix("- [ ]") {
        (false, r)
    } else {
        (true, trimmed.strip_prefix("- [x]").or_else(|| trimmed.strip_prefix("- [X]"))?)
    };

    let (rest, source_note, source_date) = extract_provenance(rest.trim());
    let (rest, email_provenance) = if source_note.is_none() {
        extract_email_provenance(rest.trim())
    } else {
        (rest, None)
    };

    let mut titre = rest.trim().to_string();
    let mut responsable = None;
    let mut echeance = None;
    let mut project = None;
    let mut priority = None;
    let mut estimate = None;

    let parts: Vec<&str> = rest.split(" — ").map(|p| p.trim()).collect();
    if parts.len() > 1 {
        titre = parts[0].to_string();
        for part in &parts[1..] {
            if let Some(r) = part.strip_prefix('@') {
                responsable = Some(r.trim().to_string());
            } else if let Some(d) = part.strip_prefix("📅") {
                echeance = Some(d.trim().to_string());
            } else if let Some(p) = part.strip_prefix('+') {
                project = Some(p.trim().to_string());
            } else if let Some(p) = part.strip_prefix('!') {
                let p = p.trim().to_lowercase();
                if VALID_PRIORITIES.contains(&p.as_str()) {
                    priority = Some(p);
                }
            } else if let Some(e) = part.strip_prefix('⏱') {
                estimate = Some(e.trim().to_string());
            }
        }
    }

    if titre.is_empty() {
        return None;
    }
    Some((
        checked,
        TaskFields { titre, responsable, echeance, project, priority, estimate, source_note, source_date, email_provenance },
    ))
}

/// Extract the normalized title from an existing checkbox line — used for
/// file-wide dedup (spec/06).
fn title_from_line(line: &str) -> Option<String> {
    parse_line(line).map(|(_, f)| normalize_title(&f.titre))
}

/// A top-level task checkbox line MUST start at column 0 — an indented line
/// (`  - ...` / `  > ...`) belongs to the PRECEDING task's block, never a task
/// of its own (spec/06 2e passe).
fn is_task_checkbox_line(line: &str) -> bool {
    if line.starts_with(' ') || line.starts_with('\t') {
        return false;
    }
    let t = line.trim_start();
    t.starts_with("- [ ]") || t.starts_with("- [x]") || t.starts_with("- [X]")
}

/// A task's trailing block line: indented by at least one space/tab and non-blank.
fn is_block_line(line: &str) -> bool {
    (line.starts_with(' ') || line.starts_with('\t')) && !line.trim().is_empty()
}

/// Parse a task's trailing indented lines into its `TaskBlock` (spec/06 2e passe).
/// `  > texte` → description line ; `  - texte` → sous-puce ; anything else
/// indented is kept as an extra description line rather than silently dropped
/// (e.g. hand-edited content in Obsidian that doesn't match our exact markers).
fn parse_block_lines(lines: &[String]) -> TaskBlock {
    let mut block = TaskBlock::default();
    for line in lines {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("> ").or_else(|| t.strip_prefix('>')) {
            block.description.push(rest.trim().to_string());
        } else if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix('-')) {
            block.notes.push(rest.trim().to_string());
        } else if !t.is_empty() {
            block.description.push(t.to_string());
        }
    }
    block
}

/// Render a `TaskBlock`'s lines (description first, then sous-puces) — the
/// counterpart of `parse_block_lines`.
fn render_block_lines(block: &TaskBlock) -> Vec<String> {
    let mut out = Vec::new();
    for d in &block.description {
        let d = d.trim();
        if !d.is_empty() {
            out.push(format!("  > {}", d));
        }
    }
    for n in &block.notes {
        let n = n.trim();
        if !n.is_empty() {
            out.push(format!("  - {}", n));
        }
    }
    out
}

/// Merge `tasks` into `existing` content (spec/06 format), appending non-duplicate
/// tasks (by normalized title, across the whole file) to `## À faire`. When
/// `provenance` is `Some((source_note, source_date))` (spec/05/06), every
/// appended task is stamped with it — the ingestion call that produced them.
/// Returns the new full file content and how many tasks were actually added.
pub fn merge_tasks(existing: Option<&str>, tasks: &[IngestTask], provenance: Option<(&str, &str)>, lang: &str) -> (String, usize) {
    // section name -> lines already in that section (in original order).
    let mut sections: Vec<(String, Vec<String>)> =
        SECTIONS.iter().map(|s| (s.to_string(), Vec::new())).collect();

    if let Some(content) = existing {
        let mut current: Option<usize> = None;
        for raw_line in content.lines() {
            let trimmed = raw_line.trim_end();
            if let Some(name) = trimmed.trim().strip_prefix("## ") {
                let name = name.trim();
                // Reconnaît les 4 sections stables même écrites en anglais
                // (spec/21), ou un ancien en-tête retiré (spec/06 v2 — ex.
                // `Prioritaire`) — replie dans le même compartiment FR interne
                // au lieu de dupliquer une section "inconnue".
                let canonical = canonical_section(name).or_else(|| migration_alias(name)).unwrap_or(name);
                current = match sections.iter().position(|(s, _)| s == canonical) {
                    Some(idx) => Some(idx),
                    None => {
                        // Unknown section — preserve it verbatim, appended at the end.
                        sections.push((canonical.to_string(), Vec::new()));
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

    migrate_stray_checked(&mut sections);

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
        let mut fields = TaskFields::from(task);
        if let Some((note, date)) = provenance {
            fields.source_note = Some(note.to_string());
            fields.source_date = Some(date.to_string());
        }
        sections[target_idx].1.push(render_line(&fields));
        added += 1;
    }

    // Structuration statut → projet → priorité (spec/06) : au sein de chacune
    // des 4 sections stables, regroupe par `+Projet` (« Sans projet » en
    // dernier) puis trie par `!priorité` — sections perso (non reconnues)
    // laissées telles quelles, non concernées par ce regroupement.
    for (name, lines) in sections.iter_mut() {
        if SECTIONS.contains(&name.as_str()) {
            *lines = group_lines_by_project(lines, lang);
        }
    }

    let mut out = String::new();
    for (name, lines) in &sections {
        out.push_str(&format!("## {}\n", section_label(name, lang)));
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

/// Regroupe les tâches d'une section par `+Projet` (« Sans projet » toujours
/// en dernier), puis trie par `!priorité` au sein de chaque groupe (spec/06 —
/// structuration du fichier statut → projet → priorité). Pas d'en-tête `###`
/// quand un seul groupe est présent (y compris s'il s'agit de « Sans projet
/// » seul) — la structure ne s'affiche que quand elle apporte de l'info,
/// pour ne pas alourdir une liste perso qui ne tague jamais de projet.
///
/// Les en-têtes `### Projet` sont entièrement DÉRIVÉS du marqueur `+Projet`
/// de chaque ligne — jamais la source de vérité — donc régénérés à chaque
/// écriture : un ancien en-tête `### ...` est toujours ignoré en lecture
/// (jamais préservé tel quel), ce qui rend le résultat auto-cohérent même
/// après une édition manuelle dans Obsidian qui aurait déplacé une tâche
/// sous le mauvais groupe sans changer son marqueur `+Projet`.
fn group_lines_by_project(lines: &[String], lang: &str) -> Vec<String> {
    if lines.is_empty() {
        return Vec::new();
    }

    struct Block {
        project: String,
        priority: Option<String>,
        lines: Vec<String>,
    }

    let mut blocks: Vec<Block> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = &lines[i];
        if line.trim_start().starts_with("### ") {
            i += 1; // en-tête de projet régénéré — jamais préservé tel quel
            continue;
        }
        if let Some((_, fields)) = parse_line(line) {
            let mut block_lines = vec![line.clone()];
            let mut j = i + 1;
            while j < lines.len() && is_block_line(&lines[j]) {
                block_lines.push(lines[j].clone());
                j += 1;
            }
            blocks.push(Block {
                project: fields.project.unwrap_or_default(),
                priority: fields.priority,
                lines: block_lines,
            });
            i = j;
        } else {
            // Ligne libre non rattachée à une tâche (texte perso, ligne
            // inconnue) — conservée, rangée dans le groupe « Sans projet ».
            blocks.push(Block { project: String::new(), priority: None, lines: vec![line.clone()] });
            i += 1;
        }
    }

    let mut projects: Vec<String> = blocks
        .iter()
        .map(|b| b.project.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    projects.sort_by(|a, b| match (a.is_empty(), b.is_empty()) {
        (true, true) => std::cmp::Ordering::Equal,
        (true, false) => std::cmp::Ordering::Greater, // « Sans projet » toujours en dernier
        (false, true) => std::cmp::Ordering::Less,
        (false, false) => a.cmp(b),
    });

    let show_headers = projects.len() > 1;
    let mut out = Vec::new();
    for project in &projects {
        let mut group: Vec<&Block> = blocks.iter().filter(|b| &b.project == project).collect();
        group.sort_by_key(|b| priority_rank(&b.priority)); // tri stable : ordre d'origine conservé entre égalités
        if show_headers {
            out.push(format!("### {}", if project.is_empty() { no_project_label(lang) } else { project }));
        }
        for b in group {
            out.extend(b.lines.iter().cloned());
        }
    }
    out
}

fn priority_rank(p: &Option<String>) -> u8 {
    match p.as_deref() {
        Some("haute") => 0,
        Some("moyenne") => 1,
        Some("basse") => 2,
        _ => 3,
    }
}

/// Migration (spec/06 v2) : une tâche `[x]` qui traînait dans une section
/// autre que `Fait`/`Archivé` (fichier écrit avant le retrait de
/// `Prioritaire`) est **déplacée** vers `## Fait`, bloc entier (ligne +
/// sous-puces/description) — les tâches déjà dans `## Archivé` restent en
/// place, cochées ou non (spec/06 : Archivé ≠ Fait).
fn migrate_stray_checked(sections: &mut Vec<(String, Vec<String>)>) {
    let Some(done_idx) = sections.iter().position(|(s, _)| s == DONE_SECTION) else { return };

    let mut moved: Vec<String> = Vec::new();
    for idx in 0..sections.len() {
        if idx == done_idx || sections[idx].0 == "Archivé" {
            continue;
        }
        let lines = std::mem::take(&mut sections[idx].1);
        let mut kept = Vec::with_capacity(lines.len());
        let mut i = 0;
        while i < lines.len() {
            let is_checked = parse_line(&lines[i]).map(|(checked, _)| checked).unwrap_or(false);
            if is_checked {
                moved.push(lines[i].clone());
                i += 1;
                while i < lines.len() && is_block_line(&lines[i]) {
                    moved.push(lines[i].clone());
                    i += 1;
                }
            } else {
                kept.push(lines[i].clone());
                i += 1;
            }
        }
        sections[idx].1 = kept;
    }
    sections[done_idx].1.extend(moved);
}

/// Ré-applique le squelette de sections (alias de migration + tâches cochées
/// égarées → `## Fait`) sans ajouter de tâche — appelé au chargement pour que
/// les fichiers écrits avant spec/06 v2 se corrigent tout seuls dès la
/// première lecture après mise à jour. Sans effet (idempotent) une fois migré.
pub fn migrate(content: &str, lang: &str) -> String {
    merge_tasks(Some(content), &[], None, lang).0
}

/// Read `{vault_root}/{todo_rel_path}` (missing file = empty doc), merge `tasks`
/// into it (stamped with `provenance` — spec/05/06 « provenance de la tâche »),
/// and write the result back. Returns how many tasks were added.
pub async fn append_tasks(
    vault_root: &Path,
    todo_rel_path: &str,
    tasks: &[IngestTask],
    provenance: Option<(&str, &str)>,
    lang: &str,
) -> Result<usize> {
    if tasks.is_empty() {
        return Ok(0);
    }

    let path = vault_root.join(todo_rel_path);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let existing = tokio::fs::read_to_string(&path).await.ok();
    let (new_content, added) = merge_tasks(existing.as_deref(), tasks, provenance, lang);

    if added > 0 {
        tokio::fs::write(&path, new_content).await?;
    }

    Ok(added)
}

// ─── Full parse + line mutations (spec/06 lifecycle) ────────────────────────────

/// One parsed task, with enough context to display and to mutate it — line
/// fields plus its trailing block (spec/06 2e passe « fiche tâche »).
#[derive(Debug, Clone)]
pub struct ParsedTask {
    pub section: String,
    pub fields: TaskFields,
    pub checked: bool,
    pub block: TaskBlock,
}

/// Every task in the file, in order, tagged with the `## Section` it sits under.
/// Each task's trailing indented lines (sub-bullets/description) are consumed
/// into its `block`, not surfaced as separate entries.
pub fn parse_all(content: &str) -> Vec<ParsedTask> {
    let lines: Vec<&str> = content.lines().collect();
    let mut section = String::new();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i];
        if let Some(name) = line.trim().strip_prefix("## ") {
            // Reconnaît les 4 sections stables même écrites en anglais (spec/21).
            let name = name.trim();
            section = canonical_section(name).or_else(|| migration_alias(name)).unwrap_or(name).to_string();
            i += 1;
            continue;
        }
        if let Some((checked, fields)) = parse_line(line) {
            let mut end = i + 1;
            while end < lines.len() && is_block_line(lines[end]) {
                end += 1;
            }
            let block_lines: Vec<String> = lines[i + 1..end].iter().map(|s| s.to_string()).collect();
            out.push(ParsedTask {
                section: section.clone(),
                fields,
                checked,
                block: parse_block_lines(&block_lines),
            });
            i = end;
        } else {
            i += 1;
        }
    }
    out
}

/// Locate the task whose normalized title matches `id` → its block's
/// `[start, end)` line-index range (task line included, trailing indented
/// lines included, next top-level line excluded).
fn find_task_block(lines: &[&str], id: &str) -> Option<(usize, usize)> {
    for (i, line) in lines.iter().enumerate() {
        if let Some((_, fields)) = parse_line(line) {
            if normalize_title(&fields.titre) == id {
                let mut end = i + 1;
                while end < lines.len() && is_block_line(lines[end]) {
                    end += 1;
                }
                return Some((i, end));
            }
        }
    }
    None
}

/// Apply `f` to the task block (its checkbox line + trailing indented lines)
/// whose normalized title matches `id`. `f` returns the replacement lines (or
/// `None` to delete the block entirely). Returns an error if no such task exists.
fn map_task_block(
    content: &str,
    id: &str,
    mut f: impl FnMut(&[String], bool, &TaskFields, &TaskBlock) -> Option<Vec<String>>,
) -> Result<String> {
    let lines: Vec<String> = content.lines().map(str::to_string).collect();
    let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
    let Some((start, end)) = find_task_block(&refs, id) else {
        return Err(anyhow!("Tâche introuvable dans Todo.md : {id}"));
    };
    let (checked, fields) = parse_line(&lines[start]).expect("find_task_block validated this line");
    let block = parse_block_lines(&lines[start + 1..end]);
    let block_lines = &lines[start..end];
    let replacement = f(block_lines, checked, &fields, &block);

    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    out.extend_from_slice(&lines[..start]);
    if let Some(rep) = replacement {
        out.extend(rep);
    }
    out.extend_from_slice(&lines[end..]);
    Ok(out.join("\n").trim_end().to_string() + "\n")
}

/// Flip the checkbox marker in place — no section move (used internally by
/// `set_checked`/`move_task`, which enforce where the bijection sends the task).
fn set_checkbox_only(content: &str, id: &str, checked: bool) -> Result<String> {
    map_task_block(content, id, |block, _, fields, _| {
        let mut line0 = render_line(fields);
        if checked {
            line0 = line0.replacen("- [ ]", "- [x]", 1);
        }
        let mut out = vec![line0];
        out.extend(block[1..].iter().cloned());
        Some(out)
    })
}

/// Cocher/décocher = **déplacer** (spec/06 v2) : cocher envoie la tâche dans
/// `## Fait`, décocher la renvoie dans `## À faire` — plus un simple marqueur
/// laissé en place. Délègue à `move_task`, qui applique la même bijection
/// pour le glisser-déposer Kanban (déposer dans `Fait` coche ; en sortir décoche).
pub fn set_checked(content: &str, id: &str, checked: bool, lang: &str) -> Result<String> {
    move_task(content, id, if checked { DONE_SECTION } else { TARGET_SECTION }, None, lang)
}

/// Move a task to `## Archivé` (spec/06 "archiver" — nothing is ever deleted).
/// The whole block (task line + sous-puces/description) moves together.
pub fn archive_task(content: &str, id: &str, lang: &str) -> Result<String> {
    let mut captured: Option<Vec<String>> = None;
    let without = map_task_block(content, id, |block, _, _, _| {
        captured = Some(block.to_vec());
        None // drop the block from its current section
    })?;
    let block = captured.expect("map_task_block found the task");

    // Re-parse sections and append to Archivé (created by merge_tasks if absent).
    let (mut out, _) = merge_tasks(Some(&without), &[], None, lang);
    if let Some(pos) = out.find("## Archivé").or_else(|| out.find("## Archived")) {
        let insert_at = out[pos..].find('\n').map(|i| pos + i + 1).unwrap_or(out.len());
        let inserted = block.iter().map(|l| format!("{}\n", l)).collect::<String>();
        out.insert_str(insert_at, &inserted);
    }
    Ok(out)
}

/// Supprime réellement une tâche (ligne + sous-puces/description) — **jamais**
/// utilisé pour une action utilisateur normale (règle d'or « supprimer = archiver »,
/// spec/06/22) : réservé au nettoyage du contenu de démarrage (`seed.rs`,
/// spec/13), où retirer les tâches semées PAR TITRE EXACT (même identité que
/// partout ailleurs — `normalize_title`) est strictement plus sûr qu'un simple
/// filtre de lignes par sous-chaîne. `Ok(())` (pas d'erreur) si `id` n'existe
/// pas — idempotent, rejouable sans risque.
pub fn remove_task(content: &str, id: &str) -> Result<String> {
    match map_task_block(content, id, |_, _, _, _| None) {
        Ok(next) => Ok(next),
        Err(_) => Ok(content.to_string()), // déjà absent — no-op
    }
}

/// Déplace une tâche vers `## section`, à `position` (index 0-based parmi les
/// TÂCHES de la section ; hors bornes / absent → fin de section). Le bloc entier
/// (ligne + sous-puces/description) se déplace ensemble ; `@responsable`,
/// `📅 échéance` et tous les autres champs sont conservés tels quels (spec/06 —
/// Kanban : colonne = section, ordre = ordre des lignes). La section cible est
/// créée si absente (sections inconnues préservées par `merge_tasks`).
///
/// **Bijection cocher ⇔ `Fait`** (spec/06 v2) : entrer dans `Fait` coche la
/// tâche ; en sortir vers une colonne de travail la décoche. `Archivé` est un
/// cas à part — une tâche y garde son état cochée/non cochée tel qu'il était
/// (spec/06 : « Archivé ≠ Fait, cochée ou non »).
pub fn move_task(content: &str, id: &str, section: &str, position: Option<usize>, lang: &str) -> Result<String> {
    let section = section.trim();
    if section.is_empty() {
        return Err(anyhow!("Section cible vide"));
    }
    let target_canonical = canonical_section(section).or_else(|| migration_alias(section)).unwrap_or(section);

    let current_section = parse_all(content)
        .into_iter()
        .find(|t| normalize_title(&t.fields.titre) == id)
        .map(|t| t.section);

    let flipped: String;
    let content = if target_canonical == DONE_SECTION {
        flipped = set_checkbox_only(content, id, true)?;
        flipped.as_str()
    } else if current_section.as_deref() == Some(DONE_SECTION) && target_canonical != "Archivé" {
        flipped = set_checkbox_only(content, id, false)?;
        flipped.as_str()
    } else {
        content
    };

    // 1. Retirer le bloc de sa section actuelle.
    let mut captured: Option<Vec<String>> = None;
    let without = map_task_block(content, id, |block, _, _, _| {
        captured = Some(block.to_vec());
        None
    })?;
    let block = captured.expect("map_task_block found the task");

    // 2. Normaliser les sections (squelette garanti), puis insérer dans la cible.
    let (normalized, _) = merge_tasks(Some(&without), &[], None, lang);
    let heading = format!("## {}", section_label(target_canonical, lang));
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
                out.extend(block.iter().cloned());
                out.push(String::new());
                inserted = true;
            }
            // Comparaison via `canonical_section` (pas la chaîne littérale) :
            // `normalized` porte les en-têtes localisés (spec/21, feedback
            // tests), donc seul l'identifiant FR interne est stable ici.
            in_target = l
                .trim()
                .strip_prefix("## ")
                .map(|n| canonical_section(n.trim()).or_else(|| migration_alias(n.trim())).unwrap_or(n.trim()))
                .map(|c| c == target_canonical)
                .unwrap_or(false);
            task_index = 0;
            out.push(l.to_string());
            continue;
        }
        if in_target && !inserted && is_task_checkbox_line(l) {
            if position.map(|p| task_index >= p).unwrap_or(false) {
                out.extend(block.iter().cloned());
                inserted = true;
            }
            task_index += 1;
        }
        out.push(l.to_string());
    }
    if in_target && !inserted {
        out.extend(block.iter().cloned());
        inserted = true;
    }
    if !inserted {
        // Section inconnue du fichier → on la crée en fin (avant rien).
        out.push(String::new());
        out.push(heading);
        out.extend(block.iter().cloned());
    }

    Ok(out.join("\n").trim_end().to_string() + "\n")
}

/// Rewrite a task's fields (title/responsable/échéance/projet/priorité/estimation)
/// in place — keeps its checked state, its block (sous-puces/description)
/// UNTOUCHED, and its provenance (source_note/source_date) PRESERVED regardless
/// of what `patch` carries there (provenance is system-set, never user-editable
/// through this path — spec/06).
pub fn edit_task(content: &str, id: &str, patch: &TaskFields) -> Result<String> {
    map_task_block(content, id, |block, checked, current, _| {
        let mut new_fields = patch.clone();
        new_fields.source_note = current.source_note.clone();
        new_fields.source_date = current.source_date.clone();
        new_fields.email_provenance = current.email_provenance.clone();
        let mut line0 = render_line(&new_fields);
        if checked {
            line0 = line0.replacen("- [ ]", "- [x]", 1);
        }
        let mut out = vec![line0];
        out.extend(block[1..].iter().cloned());
        Some(out)
    })
}

/// Rewrite a task's trailing block (sous-puces + description, spec/06 2e passe
/// « fiche tâche »). The task line itself (and all its fields) is untouched.
pub fn update_task_block(content: &str, id: &str, block: &TaskBlock) -> Result<String> {
    map_task_block(content, id, |current_block, _, _, _| {
        let mut out = vec![current_block[0].clone()];
        out.extend(render_block_lines(block));
        Some(out)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(titre: &str, responsable: Option<&str>, echeance: Option<&str>) -> IngestTask {
        IngestTask {
            project: None,
            titre: titre.to_string(),
            responsable: responsable.map(|s| s.to_string()),
            echeance: echeance.map(|s| s.to_string()),
            email_provenance: None,
        }
    }

    #[test]
    fn creates_skeleton_when_missing() {
        let (out, added) = merge_tasks(None, &[task("Relire le contrat", Some("Jean"), Some("2026-07-10"))], None, "fr");
        assert_eq!(added, 1);
        assert!(out.contains("## Fait\n"));
        assert!(out.contains("## À faire\n"));
        assert!(out.contains("- [ ] Relire le contrat — @Jean — 📅 2026-07-10"));
        assert!(out.contains("## Archivé\n"));
    }

    #[test]
    fn writes_headers_localized_to_app_language() {
        // Feedback tests : le fichier doit enfin prendre la langue de l'appli
        // à l'écriture, pas seulement la reconnaître en lecture.
        let (out, _) = merge_tasks(None, &[task("Read the contract", Some("Jean"), None)], None, "en");
        assert!(out.contains("## To Do\n"), "should write the EN header:\n{out}");
        assert!(out.contains("## In Progress\n"));
        assert!(out.contains("## Done\n"));
        assert!(out.contains("## Archived\n"));
        assert!(!out.contains("À faire"), "no FR header should leak through:\n{out}");

        // Round-trip : un fichier déjà écrit en anglais reste stable
        // (`canonical_section` le reconnaît, `section_label` le réécrit pareil).
        assert_eq!(migrate(&out, "en"), out);

        // Move/archive/set_checked must localize the SAME way, not just merge_tasks.
        let id = normalize_title("Read the contract");
        let moved = move_task(&out, &id, "En cours", None, "en").unwrap();
        assert!(moved.contains("## In Progress\n"));
        let checked_pos = moved.find("- [ ] Read the contract").unwrap();
        let in_progress_pos = moved.find("## In Progress").unwrap();
        assert!(checked_pos > in_progress_pos, "task should sit under In Progress:\n{moved}");

        let archived = archive_task(&out, &id, "en").unwrap();
        assert!(archived.contains("## Archived\n"));
        let archive_pos = archived.find("## Archived").unwrap();
        let task_pos = archived.find("Read the contract").unwrap();
        assert!(task_pos > archive_pos, "task should sit under Archived:\n{archived}");
    }

    #[test]
    fn stamps_provenance_on_ingested_tasks() {
        let (out, added) = merge_tasks(
            None,
            &[task("Envoyer le rapport", None, None)],
            Some(("Réunion Flexiflit — migration GKE", "2026-07-01")),
            "fr",
        );
        assert_eq!(added, 1);
        assert!(out.contains("- [ ] Envoyer le rapport — [[Réunion Flexiflit — migration GKE]] (2026-07-01)"));
    }

    #[test]
    fn stamps_project_on_ingested_tasks() {
        let ingested = IngestTask {
            titre: "Envoyer le rapport".into(),
            responsable: Some("Jean".into()),
            echeance: None,
            project: Some("Refonte Site".into()),
            email_provenance: None,
        };
        let (out, added) = merge_tasks(None, &[ingested], Some(("Réunion kickoff", "2026-07-21")), "fr");
        assert_eq!(added, 1);
        assert!(out.contains("- [ ] Envoyer le rapport — @Jean — +Refonte Site — [[Réunion kickoff]] (2026-07-21)"));
        // Round-trip : la ligne écrite doit se relire avec le même projet.
        let (_, fields) = parse_line("- [ ] Envoyer le rapport — @Jean — +Refonte Site — [[Réunion kickoff]] (2026-07-21)").unwrap();
        assert_eq!(fields.project.as_deref(), Some("Refonte Site"));
    }

    #[test]
    fn dedups_across_sections_by_normalized_title() {
        let existing = "## En cours\n- [ ] Relire   le contrat — @Jean\n\n## À faire\n\n## Fait\n\n## Archivé\n";
        let (out, added) = merge_tasks(Some(existing), &[task("relire le contrat", None, None)], None, "fr");
        assert_eq!(added, 0);
        assert_eq!(out.matches("relire le contrat").count() + out.matches("Relire   le contrat").count(), 1);
    }

    #[test]
    fn parses_fields_and_sections() {
        let content = "## En cours\n- [ ] Relire le contrat — @Jean — 📅 2026-07-10\n\n## À faire\n- [x] Vieille tâche\n";
        let tasks = parse_all(content);
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].section, "En cours");
        assert_eq!(tasks[0].fields.titre, "Relire le contrat");
        assert_eq!(tasks[0].fields.responsable.as_deref(), Some("Jean"));
        assert_eq!(tasks[0].fields.echeance.as_deref(), Some("2026-07-10"));
        assert!(!tasks[0].checked);
        assert!(tasks[1].checked);
    }

    #[test]
    fn parses_inline_project_priority_estimate_and_provenance() {
        let content = "## À faire\n- [ ] Préparer la démo — @Marie — 📅 2026-08-01 — +Atlas — !haute — ⏱2h — [[Point projet Atlas]] (2026-07-20)\n";
        let tasks = parse_all(content);
        assert_eq!(tasks.len(), 1);
        let f = &tasks[0].fields;
        assert_eq!(f.titre, "Préparer la démo");
        assert_eq!(f.responsable.as_deref(), Some("Marie"));
        assert_eq!(f.echeance.as_deref(), Some("2026-08-01"));
        assert_eq!(f.project.as_deref(), Some("Atlas"));
        assert_eq!(f.priority.as_deref(), Some("haute"));
        assert_eq!(f.estimate.as_deref(), Some("2h"));
        assert_eq!(f.source_note.as_deref(), Some("Point projet Atlas"));
        assert_eq!(f.source_date.as_deref(), Some("2026-07-20"));
    }

    #[test]
    fn provenance_title_containing_em_dash_is_not_split() {
        // The compte-rendu title (spec/05/07 nommage par sujet) can itself
        // contain " — " — must not confuse the field splitter.
        let content = "## À faire\n- [ ] Envoyer le rapport — [[Réunion Flexiflit — migration GKE]] (2026-07-01)\n";
        let tasks = parse_all(content);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].fields.titre, "Envoyer le rapport");
        assert_eq!(tasks[0].fields.source_note.as_deref(), Some("Réunion Flexiflit — migration GKE"));
        assert_eq!(tasks[0].fields.source_date.as_deref(), Some("2026-07-01"));
    }

    #[test]
    fn parses_sub_bullets_and_description_block() {
        let content = "## À faire\n- [ ] Préparer la démo\n  > Contexte : client Acme, version 2.\n  > Deuxième ligne.\n  - Vérifier les slides\n  - Tester le micro\n\n## Archivé\n";
        let tasks = parse_all(content);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].block.description, vec!["Contexte : client Acme, version 2.", "Deuxième ligne."]);
        assert_eq!(tasks[0].block.notes, vec!["Vérifier les slides", "Tester le micro"]);
    }

    #[test]
    fn checking_moves_to_fait_and_unchecking_moves_back_to_a_faire() {
        let content = "## À faire\n- [ ] Relire le contrat — @Jean\n";
        let done = set_checked(content, &normalize_title("Relire le contrat"), true, "fr").unwrap();
        assert!(done.contains("- [x] Relire le contrat — @Jean"));
        let fait_pos = done.find("## Fait").unwrap();
        let task_pos = done.find("- [x] Relire le contrat").unwrap();
        assert!(task_pos > fait_pos, "checked task should now live under Fait:\n{done}");

        let undone = set_checked(&done, &normalize_title("Relire le contrat"), false, "fr").unwrap();
        assert!(undone.contains("- [ ] Relire le contrat — @Jean"));
        let a_faire_pos = undone.find("## À faire").unwrap();
        let task_pos = undone.find("- [ ] Relire le contrat").unwrap();
        assert!(task_pos > a_faire_pos, "unchecked task should be back under À faire:\n{undone}");
    }

    #[test]
    fn archives_to_archive_section_with_block() {
        let content = "## À faire\n- [ ] Relire le contrat\n  - une sous-puce\n\n## Archivé\n- [ ] Déjà là\n";
        let out = archive_task(content, &normalize_title("Relire le contrat"), "fr").unwrap();
        let archive_pos = out.find("## Archivé").unwrap();
        let task_pos = out.find("- [ ] Relire le contrat").unwrap();
        assert!(task_pos > archive_pos, "task should now live under Archivé:\n{out}");
        assert!(out.contains("  - une sous-puce"), "sub-bullet should follow the task:\n{out}");
        assert!(out.contains("- [ ] Déjà là"));
    }

    #[test]
    fn edits_fields_and_preserves_provenance_and_block() {
        let content = "## À faire\n- [x] Vieille formulation — @Jean — [[Note source]] (2026-01-01)\n  - garder cette sous-puce\n";
        let out = edit_task(
            content,
            &normalize_title("Vieille formulation"),
            &TaskFields { titre: "Nouvelle formulation".into(), echeance: Some("2026-08-01".into()), ..Default::default() },
        )
        .unwrap();
        assert!(out.contains("- [x] Nouvelle formulation — 📅 2026-08-01 — [[Note source]] (2026-01-01)"));
        assert!(!out.contains("Vieille formulation"));
        assert!(out.contains("  - garder cette sous-puce"), "block should survive an edit:\n{out}");
    }

    #[test]
    fn updates_block_without_touching_line() {
        let content = "## À faire\n- [ ] Une tâche — @Jean\n  - ancienne sous-puce\n";
        let new_block = TaskBlock { description: vec!["Une description.".into()], notes: vec!["nouvelle sous-puce".into()] };
        let out = update_task_block(content, &normalize_title("Une tâche"), &new_block).unwrap();
        assert!(out.contains("- [ ] Une tâche — @Jean"));
        assert!(out.contains("  > Une description."));
        assert!(out.contains("  - nouvelle sous-puce"));
        assert!(!out.contains("ancienne sous-puce"));
    }

    #[test]
    fn moves_between_sections_keeping_fields_and_block() {
        let content = "## Fait\n\n## En cours\n\n## À faire\n- [x] Relire le contrat — @Jean — 📅 2026-07-10\n  - une note\n- [ ] Autre tâche\n\n## Archivé\n";
        let out = move_task(content, &normalize_title("Relire le contrat"), "En cours", None, "fr").unwrap();
        let en_cours = out.find("## En cours").unwrap();
        let fait = out.find("## Fait").unwrap();
        let pos = out.find("- [x] Relire le contrat — @Jean — 📅 2026-07-10").unwrap();
        assert!(pos > en_cours && pos < fait, "task should sit under En cours:\n{out}");
        assert!(out.contains("- [ ] Autre tâche"));
        assert!(out[en_cours..].contains("  - une note"), "sub-bullet should follow the moved task:\n{out}");
        assert!(out.contains("  - une note"));
        assert!(out.contains("- [ ] Autre tâche"));
    }

    #[test]
    fn moves_to_position_within_section() {
        let content = "## En cours\n- [ ] A\n- [ ] B\n\n## À faire\n- [ ] C\n";
        let out = move_task(content, &normalize_title("C"), "En cours", Some(1), "fr").unwrap();
        let a = out.find("- [ ] A").unwrap();
        let b = out.find("- [ ] B").unwrap();
        let c = out.find("- [ ] C").unwrap();
        assert!(a < c && c < b, "C should be between A and B:\n{out}");
    }

    #[test]
    fn move_to_same_section_reorders() {
        let content = "## À faire\n- [ ] A\n- [ ] B\n- [ ] C\n";
        let out = move_task(content, &normalize_title("C"), "À faire", Some(0), "fr").unwrap();
        let a = out.find("- [ ] A").unwrap();
        let c = out.find("- [ ] C").unwrap();
        assert!(c < a, "C should now be first:\n{out}");
    }

    #[test]
    fn unknown_id_errors() {
        let content = "## À faire\n- [ ] Une tâche\n";
        assert!(set_checked(content, "inexistante", true, "fr").is_err());
    }

    #[test]
    fn preserves_existing_lines_and_unknown_sections() {
        // "Prioritaire" ici est délibérément un ancien en-tête retiré (spec/06
        // v2) — sa tâche cochée doit migrer vers `## Fait` (voir le test dédié
        // ci-dessous), sans que "Notes perso" (section perso, jamais reconnue)
        // n'en soit affectée.
        let existing = "## Prioritaire\n- [x] Déjà fait\n\n## En cours\n\n## À faire\n- [ ] Ancienne tâche\n\n## Archivé\n\n## Notes perso\n- pense-bête\n";
        let (out, added) = merge_tasks(Some(existing), &[task("Nouvelle tâche", None, None)], None, "fr");
        assert_eq!(added, 1);
        assert!(out.contains("- [x] Déjà fait"));
        assert!(out.contains("- [ ] Ancienne tâche"));
        assert!(out.contains("- [ ] Nouvelle tâche"));
        assert!(out.contains("## Notes perso"));
        assert!(out.contains("- pense-bête"));
        assert!(!out.contains("## Prioritaire"), "Prioritaire should not survive as its own section:\n{out}");
    }

    #[test]
    fn migrates_prioritaire_header_and_stray_checked_tasks() {
        // Fichier "ancien format" (spec/06 v1) : section Prioritaire encore
        // présente, et une tâche cochée oubliée dans En cours (jamais déplacée,
        // faute de notion de section Fait à l'époque).
        let old = "## Prioritaire\n- [ ] Faire le tour d'Alfred — !haute\n\n## En cours\n- [x] Tâche cochée égarée\n\n## À faire\n- [ ] Tâche normale\n\n## Archivé\n- [x] Déjà archivée, cochée\n";
        let out = migrate(old, "fr");

        assert!(!out.contains("## Prioritaire"), "Prioritaire should be gone:\n{out}");
        // "Faire le tour d'Alfred" merges into À faire, keeping its priority.
        let a_faire = out.find("## À faire").unwrap();
        let fait = out.find("## Fait").unwrap();
        let tour_pos = out.find("Faire le tour d'Alfred — !haute").unwrap();
        assert!(tour_pos > a_faire, "should have merged into À faire:\n{out}");

        // The stray checked task moves into Fait...
        let stray_pos = out.find("- [x] Tâche cochée égarée").unwrap();
        assert!(stray_pos > fait, "stray checked task should move under Fait:\n{out}");
        // ...while the already-archived (checked) task stays in Archivé, untouched.
        let archive_pos = out.find("## Archivé").unwrap();
        let archived_task_pos = out.find("- [x] Déjà archivée, cochée").unwrap();
        assert!(archived_task_pos > archive_pos, "archived task should stay in Archivé:\n{out}");

        // Idempotent — migrating twice changes nothing further.
        assert_eq!(migrate(&out, "fr"), out);
    }

    #[test]
    fn groups_by_project_then_priority_within_a_section() {
        let content = "## À faire\n\
            - [ ] Tâche libre basse — !basse\n\
            - [ ] Atlas priorité basse — +Atlas — !basse\n\
            - [ ] Atlas priorité haute — +Atlas — !haute\n\
            - [ ] Tâche libre sans priorité\n\
            - [ ] Refonte urgente — +Refonte Site — !haute\n";
        let out = migrate(content, "fr");

        let atlas = out.find("### Atlas").unwrap();
        let refonte = out.find("### Refonte Site").unwrap();
        let sans_projet = out.find("### Sans projet").unwrap();
        // Ordre alphabétique des projets ("Atlas" < "Refonte Site"), "Sans
        // projet" toujours en dernier.
        assert!(atlas < refonte, "projects should be alphabetical:\n{out}");
        assert!(refonte < sans_projet, "Sans projet should come last:\n{out}");

        // Tri par priorité DANS le groupe Atlas : haute avant basse.
        let atlas_haute = out.find("Atlas priorité haute").unwrap();
        let atlas_basse = out.find("Atlas priorité basse").unwrap();
        assert!(atlas_haute < atlas_basse, "haute should sort before basse within a project:\n{out}");

        // Tri par priorité DANS le groupe Sans projet aussi.
        let libre_basse = out.find("Tâche libre basse").unwrap();
        let libre_sans_prio = out.find("Tâche libre sans priorité").unwrap();
        assert!(libre_basse < libre_sans_prio, "basse should sort before no-priority:\n{out}");

        // Idempotent.
        assert_eq!(migrate(&out, "fr"), out);
    }

    #[test]
    fn no_project_headers_when_a_section_has_a_single_group() {
        // Une section entièrement "Sans projet" (cas courant d'une liste
        // perso qui ne tague jamais de projet) ne doit pas se retrouver
        // encombrée d'un unique en-tête "### Sans projet" inutile.
        let content = "## À faire\n- [ ] Tâche A — !haute\n- [ ] Tâche B — !basse\n";
        let out = migrate(content, "fr");
        assert!(!out.contains("###"), "single-group section should have no ### header:\n{out}");
        // Priority sort still applies.
        let a = out.find("Tâche A").unwrap();
        let b = out.find("Tâche B").unwrap();
        assert!(a < b, "haute should still sort before basse:\n{out}");

        // Same when every task shares the SAME named project (single group too).
        let content2 = "## À faire\n- [ ] Tâche A — +Atlas — !basse\n- [ ] Tâche B — +Atlas — !haute\n";
        let out2 = migrate(content2, "fr");
        assert!(!out2.contains("###"), "single-project section should have no ### header:\n{out2}");
    }

    #[test]
    fn project_grouping_moves_sub_bullets_with_their_task() {
        let content = "## À faire\n\
            - [ ] Tâche Atlas — +Atlas\n  - une sous-puce\n\
            - [ ] Tâche libre\n";
        let out = migrate(content, "fr");
        let task_pos = out.find("- [ ] Tâche Atlas").unwrap();
        let sub_pos = out.find("  - une sous-puce").unwrap();
        assert!(sub_pos > task_pos && sub_pos < task_pos + 40, "sub-bullet should stay right after its task:\n{out}");
    }

    #[test]
    fn indented_dash_line_is_not_mistaken_for_a_new_task() {
        // A "- pense-bête" style line under an unrelated section header must
        // never be swallowed into a preceding task's block just because it
        // starts with "- ": it's not indented, so it stays its own top-level
        // (non-task) line.
        let content = "## Notes perso\n- pense-bête\n";
        let tasks = parse_all(content);
        assert!(tasks.is_empty());
    }
}
