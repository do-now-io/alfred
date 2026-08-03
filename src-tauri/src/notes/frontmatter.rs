use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct NoteMetadata {
    pub title: String,
    pub date: String,
    pub tags: Vec<String>,
    #[serde(rename = "type")]
    pub note_type: String,
    pub status: String,
    pub recording_id: Option<String>,
    /// First names of meeting participants, when known (spec/05 ingestion).
    #[serde(default)]
    pub participants: Vec<String>,
    /// Vault projects this note belongs to (spec/07) — une note peut relever de
    /// PLUSIEURS projets (feedback tests) : elle apparaît sous chacun dans la vue
    /// Projets. Lecture rétro-compatible avec l'ancienne forme scalaire.
    #[serde(default)]
    pub project: Vec<String>,
}

impl NoteMetadata {
    pub fn new(title: &str) -> Self {
        Self {
            title: title.to_string(),
            date: chrono::Local::now().format("%Y-%m-%d").to_string(),
            tags: vec![],
            note_type: "note".to_string(),
            status: "active".to_string(),
            recording_id: None,
            participants: vec![],
            project: vec![],
        }
    }

    pub fn for_recording(title: &str, recording_id: &str) -> Self {
        Self {
            title: title.to_string(),
            date: chrono::Local::now().format("%Y-%m-%d").to_string(),
            tags: vec![],
            note_type: "meeting".to_string(),
            status: "active".to_string(),
            recording_id: Some(recording_id.to_string()),
            participants: vec![],
            project: vec![],
        }
    }

    /// The compte-rendu note produced by ingestion (spec/05): same `recording_id`
    /// as the raw transcription note, plus whatever participants/project the AI
    /// could identify (project-based grouping itself is a later feature — spec/07).
    pub fn for_meeting_report(
        title: &str,
        recording_id: Option<&str>,
        participants: Vec<String>,
        project: Vec<String>,
    ) -> Self {
        Self {
            title: title.to_string(),
            date: chrono::Local::now().format("%Y-%m-%d").to_string(),
            tags: vec![],
            note_type: "meeting".to_string(),
            status: "active".to_string(),
            recording_id: recording_id.map(|s| s.to_string()),
            participants,
            project,
        }
    }

    /// Note de contexte (spec/16/16b) — `type: context`, reconnue par ce
    /// frontmatter plutôt qu'un chemin unique en dur : couvre `Contexte
    /// Alfred.md` (contexte global, `project` vide) ET chaque note de contexte
    /// de projet (`alfred-intelligence/<Projet>.md`, `project: [<Nom>]`).
    pub fn for_context(title: &str, project: Option<&str>) -> Self {
        Self {
            title: title.to_string(),
            date: chrono::Local::now().format("%Y-%m-%d").to_string(),
            tags: vec![],
            note_type: "context".to_string(),
            status: "active".to_string(),
            recording_id: None,
            participants: vec![],
            project: project.map(|p| vec![p.to_string()]).unwrap_or_default(),
        }
    }

    pub fn prop_count(&self) -> usize {
        let mut count = 2; // title + date always present
        if !self.tags.is_empty() { count += 1; }
        if self.note_type != "note" { count += 1; }
        if self.status != "active" { count += 1; }
        if self.recording_id.is_some() { count += 1; }
        if !self.participants.is_empty() { count += 1; }
        if !self.project.is_empty() { count += 1; }
        count
    }
}

/// Parse raw `.md` file content into (NoteMetadata, body).
/// If no valid frontmatter is found, returns defaults derived from filename.
pub fn parse(raw: &str, filename_stem: &str) -> (NoteMetadata, String) {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return (NoteMetadata::new(filename_stem), raw.to_string());
    }

    // Find closing ---
    let after_open = &trimmed[3..];
    // Skip optional newline right after ---
    let after_open = after_open.strip_prefix('\n').unwrap_or(after_open);

    let close_pos = after_open.find("\n---")
        .or_else(|| after_open.find("\r\n---"));

    let (fm_block, body) = match close_pos {
        Some(pos) => {
            let fm = &after_open[..pos];
            let rest = &after_open[pos + 4..]; // skip \n---
            // Strip ALL leading blank-line characters, not just one — makes
            // serialize→parse idempotent regardless of how many accumulated
            // (self-healing for notes already affected by that drift; see
            // the matching fix in Notes.tsx's `handleBodyChange` no-op guard).
            let rest = rest.trim_start_matches(['\n', '\r']);
            (fm, rest.to_string())
        }
        None => return (NoteMetadata::new(filename_stem), raw.to_string()),
    };

    let mut metadata = NoteMetadata::new(filename_stem);

    for line in fm_block.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }

        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim();
            let value = value.trim();

            match key {
                "title" => metadata.title = value.trim_matches('"').to_string(),
                "date"  => metadata.date = value.to_string(),
                "type"  => metadata.note_type = value.to_string(),
                "status" => metadata.status = value.to_string(),
                "recording_id" => {
                    if !value.is_empty() && value != "null" && value != "~" {
                        metadata.recording_id = Some(value.to_string());
                    }
                }
                "tags" => {
                    // Supports: [tag1, tag2] or - tag1 (block list handled below)
                    let v = value.trim().trim_matches('[').trim_matches(']');
                    if !v.is_empty() {
                        metadata.tags = v
                            .split(',')
                            .map(|t| t.trim().trim_matches('"').to_string())
                            .filter(|t| !t.is_empty())
                            .collect();
                    }
                }
                "participants" => {
                    let v = value.trim().trim_matches('[').trim_matches(']');
                    if !v.is_empty() {
                        metadata.participants = v
                            .split(',')
                            .map(|t| t.trim().trim_matches('"').to_string())
                            .filter(|t| !t.is_empty())
                            .collect();
                    }
                }
                "project" => {
                    // LISTE `[A, B]` — mais accepte aussi l'ancienne forme
                    // scalaire `project: A` (rétro-compat, spec/07).
                    if !value.is_empty() && value != "null" && value != "~" {
                        let v = value.trim().trim_matches('[').trim_matches(']');
                        metadata.project = v
                            .split(',')
                            .map(|p| p.trim().trim_matches('"').to_string())
                            .filter(|p| !p.is_empty())
                            .collect();
                    }
                }
                _ => {} // ignore unknown keys
            }
        } else if line.starts_with("- ") && line.len() > 2 {
            // Block list item — assume it belongs to the last list key (tags)
            metadata.tags.push(line[2..].trim().to_string());
        }
    }

    (metadata, body)
}

/// Serialize NoteMetadata + body back to a complete `.md` file string.
pub fn serialize(metadata: &NoteMetadata, body: &str) -> String {
    let mut out = String::from("---\n");

    out.push_str(&format!("title: {}\n", metadata.title));
    out.push_str(&format!("date: {}\n", metadata.date));

    if metadata.tags.is_empty() {
        out.push_str("tags: []\n");
    } else {
        let tags_str = metadata.tags
            .iter()
            .map(|t| t.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        out.push_str(&format!("tags: [{}]\n", tags_str));
    }

    out.push_str(&format!("type: {}\n", metadata.note_type));
    out.push_str(&format!("status: {}\n", metadata.status));

    if let Some(ref rid) = metadata.recording_id {
        out.push_str(&format!("recording_id: {}\n", rid));
    }

    if !metadata.participants.is_empty() {
        let participants_str = metadata.participants
            .iter()
            .map(|p| p.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        out.push_str(&format!("participants: [{}]\n", participants_str));
    }

    if !metadata.project.is_empty() {
        let project_str = metadata.project
            .iter()
            .map(|p| p.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        out.push_str(&format!("project: [{}]\n", project_str));
    }

    out.push_str("---\n\n");
    out.push_str(body);

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let meta = NoteMetadata {
            title: "Test Note".into(),
            date: "2026-06-11".into(),
            tags: vec!["work".into(), "test".into()],
            note_type: "note".into(),
            status: "active".into(),
            recording_id: None,
            participants: vec![],
            project: vec![],
        };
        let body = "# Test\n\nHello world.";
        let raw = serialize(&meta, body);
        let (parsed_meta, parsed_body) = parse(&raw, "test-note");
        assert_eq!(parsed_meta.title, "Test Note");
        assert_eq!(parsed_meta.tags, vec!["work", "test"]);
        assert_eq!(parsed_body.trim(), body.trim());
    }

    #[test]
    fn serialize_parse_roundtrip_never_grows_leading_blank_lines() {
        // Regression: `serialize` always inserts exactly one blank line after
        // `---`; if `parse` only stripped ONE leading newline back out, a body
        // that already started with a blank line would gain one more on every
        // round trip (opening then silently re-saving a note, repeatedly).
        let meta = NoteMetadata::new("n");
        let (_, body1) = parse(&serialize(&meta, "\n\ntext"), "n");
        assert_eq!(body1, "text");
        // Idempotent even starting from an ALREADY-drifted note (self-healing
        // for notes affected by the bug before this fix).
        let (_, body2) = parse(&serialize(&meta, &body1), "n");
        assert_eq!(body2, "text");
    }

    #[test]
    fn no_frontmatter() {
        let raw = "# Just a note\n\nNo frontmatter here.";
        let (meta, body) = parse(raw, "my-file");
        assert_eq!(meta.title, "my-file");
        assert_eq!(body, raw);
    }

    #[test]
    fn project_list_roundtrips() {
        let mut meta = NoteMetadata::new("n");
        meta.project = vec!["Acme".into(), "Interne".into()];
        let raw = serialize(&meta, "corps");
        assert!(raw.contains("project: [Acme, Interne]"));
        let (parsed, _) = parse(&raw, "n");
        assert_eq!(parsed.project, vec!["Acme", "Interne"]);
    }

    #[test]
    fn project_scalar_is_accepted() {
        // Rétro-compat : l'ancienne forme scalaire se lit comme une liste de 1.
        let raw = "---\ntitle: T\ndate: 2026-01-01\nproject: Acme\n---\ncorps";
        let (parsed, _) = parse(raw, "t");
        assert_eq!(parsed.project, vec!["Acme"]);
    }
}
