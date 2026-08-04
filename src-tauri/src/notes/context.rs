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

/// Titres localisés selon `app_language` (spec/16/21). Le **nom de fichier**
/// de la note reste stable quelle que soit la langue (`DEFAULT_CONTEXT_NOTE`)
/// — seuls les titres à l'intérieur du corps suivent la langue courante. Une
/// section existante est reconnue par sa position/son contenu, jamais par le
/// libellé exact seul : `context_has_content`/`has_learned_heading` matchent
/// les DEUX langues, pour rester robustes si l'utilisateur change de langue
/// après coup (le fichier garde alors un mélange FR/EN, ce qui est voulu —
/// on ne réécrit jamais silencieusement les titres existants).
pub(crate) struct ContextTitles {
    pub doc_title: &'static str,
    pub intro: &'static str,
    pub company: &'static str,
    pub team: &'static str,
    pub vocab: &'static str,
    pub projects: &'static str,
    /// spec/17 §4 — section auto-alimentée après ingestion.
    pub learned_auto: &'static str,
}

const TITLES_FR: ContextTitles = ContextTitles {
    doc_title: "Contexte Alfred",
    intro: "Décris ici ton environnement de travail : Alfred s'en sert pour corriger les\nnoms propres et le vocabulaire dans les transcriptions et les comptes-rendus.",
    company: "Mon entreprise",
    team: "Équipe (prénoms & rôles)",
    vocab: "Vocabulaire maison & noms propres",
    projects: "Projets en cours",
    learned_auto: "Appris automatiquement",
};

const TITLES_EN: ContextTitles = ContextTitles {
    doc_title: "Alfred context",
    intro: "Describe your work environment here: Alfred uses it to correct proper\nnouns and vocabulary in transcriptions and summaries.",
    company: "My company",
    team: "Team (names & roles)",
    vocab: "House vocabulary & proper nouns",
    projects: "Current projects",
    learned_auto: "Automatically learned",
};

/// Canonical slot (0=company, 1=team, 2=vocab, 3=projects) for a `## ` heading
/// written in either language — `None` for anything else: `## Appris
/// automatiquement` (spec/17 §4, a distinct auto-fed section), a leftover
/// `## Appris à l'oral (date)` block from before this fix, or any section the
/// user added by hand. The voice rebuild (`write_spoken_context`) never
/// touches those.
fn canonical_slot(heading: &str) -> Option<usize> {
    let h = heading.trim();
    [
        (TITLES_FR.company, TITLES_EN.company),
        (TITLES_FR.team, TITLES_EN.team),
        (TITLES_FR.vocab, TITLES_EN.vocab),
        (TITLES_FR.projects, TITLES_EN.projects),
    ]
    .iter()
    .position(|(fr, en)| h.eq_ignore_ascii_case(fr) || h.eq_ignore_ascii_case(en))
}

/// Splits a note body into the leading preamble (everything before the first
/// `## ` heading — title + intro) and its ordered `## ` section blocks.
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

pub(crate) fn titles(lang: &str) -> &'static ContextTitles {
    if lang == "en" { &TITLES_EN } else { &TITLES_FR }
}

async fn lang(db: &SqlitePool) -> String {
    crate::ai::app_language(db).await
}

fn context_template(lang: &str) -> String {
    let t = titles(lang);
    format!(
        "# {}\n\n{}\n\n## {}\n\n## {}\n\n## {}\n\n## {}\n",
        t.doc_title, t.intro, t.company, t.team, t.vocab, t.projects
    )
}

/// Reconnaît `## Appris automatiquement` **ou** `## Automatically learned` —
/// peu importe dans quelle langue la note a été écrite (spec/16 « piège »).
fn has_learned_heading(body: &str) -> bool {
    body.lines().any(|l| {
        let t = l.trim();
        t == format!("## {}", TITLES_FR.learned_auto) || t == format!("## {}", TITLES_EN.learned_auto)
    })
}

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

/// Lazily create the context note with its template, localisé selon
/// `app_language` (spec/16/21). Never overwrites.
pub async fn ensure_context_note(vault_root: &Path, db: &SqlitePool) -> Result<PathBuf> {
    let path = vault_root.join(context_note_path(db).await);
    if !path.exists() {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        // `type: context` (spec/16b) — reconnue par le frontmatter plutôt
        // qu'un chemin en dur, couvre aussi les notes de contexte de projet.
        let metadata = super::NoteMetadata::for_context("Contexte Alfred", None);
        let content = super::frontmatter::serialize(&metadata, &context_template(&lang(db).await));
        tokio::fs::write(&path, content).await?;
    }
    Ok(path)
}

/// Does the context note carry real user/AI content beyond the empty template?
/// Headings, blank lines and EVERY line of the template **in either language**
/// (intro paragraph included) don't count — the untouched template must never
/// take the append path (spec/16 bug « blocs vides » : l'intro fait deux
/// lignes, filtrer sur « Décris ici » ne couvrait que la première ; matcher
/// les deux langues couvre le cas d'un changement de langue de l'app après la
/// création de la note, spec/21).
fn context_has_content(body: &str) -> bool {
    let mut template_lines: std::collections::HashSet<String> = std::collections::HashSet::new();
    for l in ["fr", "en"] {
        for line in context_template(l).lines() {
            let t = line.trim();
            if !t.is_empty() {
                template_lines.insert(t.to_string());
            }
        }
    }
    body.lines().any(|l| {
        let t = l.trim();
        !t.is_empty() && !t.starts_with('#') && !template_lines.contains(t)
    })
}

/// Write the spoken-onboarding context (spec/13/16). If the note is still the
/// empty template, replace its body with the structured version. If it already
/// has content, **replace the 4 canonical sections** (company/team/vocab/
/// projects) in place with the fresh output — idempotent, a rebuild cleanly
/// overwrites the previous one instead of stacking a whole new structure under
/// a dated `## Appris à l'oral` heading (spec/16 bug « empilement en double »).
/// Everything else — title/intro, `## Appris automatiquement` (spec/17 §4, a
/// distinct auto-fed flow), any leftover pre-fix `## Appris à l'oral (date)`
/// block, or a section the user added by hand — is preserved untouched, in its
/// original relative position. Trade-off (accepted, spec/16): manually edited
/// canonical sections get overwritten by a voice rebuild.
pub async fn write_spoken_context(vault_root: &Path, db: &SqlitePool, structured_body: &str) -> Result<()> {
    let path = ensure_context_note(vault_root, db).await?;
    let raw = tokio::fs::read_to_string(&path).await?;
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let (metadata, body) = super::frontmatter::parse(&raw, &stem);

    let new_body = if context_has_content(&body) {
        let (preamble, existing_sections) = split_sections(&body);
        // `structured_body` is always assembled by the caller as exactly the 4
        // canonical sections, in fixed order (company/team/vocab/projects) —
        // index into it doubles as the canonical slot.
        let (_, fresh_sections) = split_sections(structured_body);
        let fresh_content: Vec<&str> = fresh_sections.iter().map(|(_, c)| c.as_str()).collect();

        let mut filled_slots = [false; 4];
        let mut out_sections: Vec<(String, String)> = Vec::new();
        for (heading, content) in &existing_sections {
            match canonical_slot(heading) {
                Some(slot) if !filled_slots[slot] => {
                    filled_slots[slot] = true;
                    out_sections.push((heading.clone(), fresh_content.get(slot).copied().unwrap_or("").to_string()));
                }
                // A 2nd/3rd occurrence of the same canonical slot is a leftover
                // duplicate from before this fix — dropped, self-healing.
                Some(_) => {}
                None => out_sections.push((heading.clone(), content.clone())),
            }
        }
        // A canonical slot missing entirely (user deleted that section) is
        // (re)added at the end, headed in the current UI language.
        let t = titles(&lang(db).await);
        for (slot, heading) in [t.company, t.team, t.vocab, t.projects].into_iter().enumerate() {
            if !filled_slots[slot] {
                out_sections.push((heading.to_string(), fresh_content.get(slot).copied().unwrap_or("").to_string()));
            }
        }

        let mut rebuilt = preamble.trim_end().to_string();
        for (heading, content) in &out_sections {
            rebuilt.push_str(&format!("\n\n## {}\n\n{}", heading, content.trim()));
        }
        format!("{}\n", rebuilt.trim_start_matches('\n'))
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
    if has_learned_heading(&body) {
        // Append right after the existing section's last bullet. Simplest robust
        // approach: rebuild by inserting the new bullets just after the heading —
        // whichever language it's ACTUALLY written in (spec/16 « piège »), never
        // forced to the current `app_language`.
        let mut out = String::new();
        let mut inserted = false;
        for line in new_body.lines() {
            out.push_str(line);
            out.push('\n');
            let t = line.trim();
            let is_heading = t == format!("## {}", TITLES_FR.learned_auto) || t == format!("## {}", TITLES_EN.learned_auto);
            if !inserted && is_heading {
                for f in &to_add {
                    out.push_str(&format!("- {}\n", f));
                }
                inserted = true;
            }
        }
        new_body = out.trim_end().to_string();
    } else {
        let heading = format!("## {}", titles(&lang(db).await).learned_auto);
        new_body.push_str(&format!("\n\n{}\n", heading));
        for f in &to_add {
            new_body.push_str(&format!("- {}\n", f));
        }
        new_body = new_body.trim_end().to_string();
    }

    let content = super::frontmatter::serialize(&metadata, &format!("{}\n", new_body));
    tokio::fs::write(&path, content).await?;
    Ok(to_add.len())
}

/// Append `terms` (spec/16b §2/§3 — `vocab_terms`, indépendant du `scope` des
/// `context_addition`) to the `## Vocabulaire maison & noms propres` canonical
/// section, deduped against existing bullet lines. Always the global note,
/// regardless of "Projets concernés" (no per-project vocabulary — constraint
/// on `initial_prompt` size, spec/17 §1). Recreates the section (localised,
/// at the end) if the user had deleted it. Returns the number actually added.
pub async fn append_vocab_terms(vault_root: &Path, db: &SqlitePool, terms: &[String]) -> Result<usize> {
    let clean: Vec<String> = terms.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
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
        // Slot 2 = vocab (see `canonical_slot`'s ordering: company/team/vocab/projects).
        if !inserted && canonical_slot(&heading) == Some(2) {
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
        // Section vocab absente (supprimée par l'utilisateur) — recréée en fin de note.
        let heading = titles(&lang(db).await).vocab.to_string();
        let content: String = to_add.iter().map(|f| format!("- {}\n", f)).collect::<String>().trim_end().to_string();
        out_sections.push((heading, content));
    }

    let mut rebuilt = preamble.trim_end().to_string();
    for (heading, content) in &out_sections {
        rebuilt.push_str(&format!("\n\n## {}\n\n{}", heading, content.trim()));
    }
    let new_body = format!("{}\n", rebuilt.trim_start_matches('\n'));

    let content = super::frontmatter::serialize(&metadata, &new_body);
    tokio::fs::write(&path, content).await?;
    Ok(to_add.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untouched_template_has_no_content() {
        // The full template — intro paragraph (2 lines!) + empty headings —
        // must NOT count as user content (spec/16 bug « blocs vides »), in
        // EITHER language (spec/21).
        assert!(!context_has_content(&context_template("fr")));
        assert!(!context_has_content(&context_template("en")));
    }

    #[test]
    fn empty_or_headings_only_has_no_content() {
        assert!(!context_has_content(""));
        assert!(!context_has_content("# Contexte Alfred\n\n## Mon entreprise\n"));
        assert!(!context_has_content("# Alfred context\n\n## My company\n"));
    }

    #[test]
    fn real_user_line_counts_as_content() {
        let body = format!("{}\nJe travaille chez Do-Now.\n", context_template("fr"));
        assert!(context_has_content(&body));
    }

    #[test]
    fn learned_heading_recognized_in_either_language() {
        assert!(has_learned_heading("## Appris automatiquement\n- fact"));
        assert!(has_learned_heading("## Automatically learned\n- fact"));
        assert!(!has_learned_heading("## Something else"));
    }

    #[test]
    fn titles_localized_and_stable_filename() {
        assert_eq!(titles("fr").company, "Mon entreprise");
        assert_eq!(titles("en").company, "My company");
        // Le nom de fichier ne dépend jamais de la langue (spec/16).
        assert_eq!(DEFAULT_CONTEXT_NOTE, "Contexte Alfred.md");
    }

    #[test]
    fn canonical_slot_matches_either_language() {
        assert_eq!(canonical_slot("Mon entreprise"), Some(0));
        assert_eq!(canonical_slot("My company"), Some(0));
        assert_eq!(canonical_slot("Projets en cours"), Some(3));
        assert_eq!(canonical_slot("Appris automatiquement"), None);
        assert_eq!(canonical_slot("Appris à l'oral (2026-07-10)"), None);
        assert_eq!(canonical_slot("Notes perso"), None);
    }

    #[test]
    fn split_sections_separates_preamble_from_headings() {
        let body = "# Contexte Alfred\n\nIntro.\n\n## Mon entreprise\n\nDoNow.\n\n## Équipe (prénoms & rôles)\n\n- Marie : cheffe de projet\n";
        let (preamble, sections) = split_sections(body);
        assert_eq!(preamble.trim_end(), "# Contexte Alfred\n\nIntro.");
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].0, "Mon entreprise");
        assert_eq!(sections[0].1.trim(), "DoNow.");
        assert_eq!(sections[1].0, "Équipe (prénoms & rôles)");
        assert_eq!(sections[1].1.trim(), "- Marie : cheffe de projet");
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
