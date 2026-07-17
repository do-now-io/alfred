use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use ts_rs::TS;
use walkdir::WalkDir;

use super::frontmatter;

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub kind: String, // "note" | "tag"
    pub path: Option<String>,
    pub folder: Option<String>, // top-level folder relative to vault root, for coloring
}

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct GraphLink {
    pub source: String,
    pub target: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VaultGraph {
    pub nodes: Vec<GraphNode>,
    pub links: Vec<GraphLink>,
}

struct NoteEntry {
    path: String,
    stem: String,
    folder: Option<String>,
    tags: Vec<String>,
    wikilinks: Vec<String>,
    /// Paire transcription ↔ compte-rendu (spec/07c) : les notes qui partagent
    /// un `recording_id` sont reliées nativement (un wikilink serait ambigu tant
    /// que les deux portaient le même nom daté).
    recording_id: Option<String>,
}

pub fn build_graph(root: &Path) -> Result<VaultGraph> {
    let mut notes: Vec<NoteEntry> = vec![];

    for entry in WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path().extension().map(|x| x == "md").unwrap_or(false)
                && !e.path().components().any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        })
    {
        let Ok(raw) = std::fs::read_to_string(entry.path()) else { continue };
        let stem = entry
            .path()
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        let (metadata, body) = frontmatter::parse(&raw, &stem);

        let mut tags: Vec<String> = metadata
            .tags
            .iter()
            .map(|t| normalize_tag(t))
            .filter(|t| !t.is_empty())
            .collect();
        tags.extend(extract_inline_tags(&body));
        tags.sort();
        tags.dedup();

        let folder = entry
            .path()
            .strip_prefix(root)
            .ok()
            .and_then(|rel| rel.components().next())
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            // a file at the vault root has its own name as first component
            .filter(|f| !f.ends_with(".md"));

        notes.push(NoteEntry {
            path: entry.path().to_string_lossy().to_string(),
            stem,
            folder,
            tags,
            wikilinks: extract_wikilinks(&body),
            recording_id: metadata.recording_id.clone(),
        });
    }

    // stem (lowercased) → note path, for wikilink resolution
    let stem_map: HashMap<String, String> = notes
        .iter()
        .map(|n| (n.stem.to_lowercase(), n.path.clone()))
        .collect();

    let mut nodes: Vec<GraphNode> = vec![];
    let mut links: HashSet<(String, String)> = HashSet::new();
    let mut tag_ids: HashSet<String> = HashSet::new();

    for note in &notes {
        nodes.push(GraphNode {
            id: note.path.clone(),
            label: note.stem.clone(),
            kind: "note".to_string(),
            path: Some(note.path.clone()),
            folder: note.folder.clone(),
        });

        for target in &note.wikilinks {
            if let Some(target_path) = stem_map.get(&target.to_lowercase()) {
                if *target_path != note.path {
                    links.insert((note.path.clone(), target_path.clone()));
                }
            }
        }

        for tag in &note.tags {
            let tag_id = format!("#{}", tag);
            tag_ids.insert(tag_id.clone());
            links.insert((note.path.clone(), tag_id));
        }
    }

    // Paire enregistrement (spec/07c) : lien note → note entre toutes les notes
    // partageant le même `recording_id` (transcription brute ↔ compte-rendu).
    {
        let mut by_recording: HashMap<&str, Vec<&NoteEntry>> = HashMap::new();
        for note in &notes {
            if let Some(rid) = note.recording_id.as_deref().filter(|r| !r.trim().is_empty()) {
                by_recording.entry(rid).or_default().push(note);
            }
        }
        for group in by_recording.values() {
            for pair in group.windows(2) {
                // Ordonné (source, target) stable — le HashSet dédoublonne.
                links.insert((pair[0].path.clone(), pair[1].path.clone()));
            }
        }
    }

    let mut sorted_tags: Vec<String> = tag_ids.into_iter().collect();
    sorted_tags.sort();
    for tag_id in sorted_tags {
        nodes.push(GraphNode {
            id: tag_id.clone(),
            label: tag_id,
            kind: "tag".to_string(),
            path: None,
            folder: None,
        });
    }

    let links = links
        .into_iter()
        .map(|(source, target)| GraphLink { source, target })
        .collect();

    Ok(VaultGraph { nodes, links })
}

/// Tags distincts du vault (frontmatter + `#inline`), triés — pour
/// l'autocomplétion du panneau Properties (spec/07). Réutilise exactement la
/// même extraction que `build_graph`.
pub fn list_tags(root: &Path) -> Result<Vec<String>> {
    let mut tags: HashSet<String> = HashSet::new();
    for entry in WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path().extension().map(|x| x == "md").unwrap_or(false)
                && !e.path().components().any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        })
    {
        let Ok(raw) = std::fs::read_to_string(entry.path()) else { continue };
        let stem = entry
            .path()
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let (metadata, body) = frontmatter::parse(&raw, &stem);
        tags.extend(metadata.tags.iter().map(|t| normalize_tag(t)).filter(|t| !t.is_empty()));
        tags.extend(extract_inline_tags(&body));
    }
    let mut out: Vec<String> = tags.into_iter().collect();
    out.sort();
    Ok(out)
}

fn normalize_tag(tag: &str) -> String {
    tag.trim().trim_start_matches('#').to_lowercase()
}

/// Extracts `[[Target]]` / `[[Target|alias]]` targets from a note body.
fn extract_wikilinks(body: &str) -> Vec<String> {
    let mut out = vec![];
    let mut rest = body;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else { break };
        let inner = &rest[..end];
        let target = inner.split('|').next().unwrap_or("").trim();
        if !target.is_empty() && !target.contains('\n') {
            out.push(target.to_string());
        }
        rest = &rest[end + 2..];
    }
    out
}

/// Extracts inline `#tag` occurrences (preceded by start-of-text or whitespace,
/// followed by at least one letter — so markdown headings `# Titre` don't match).
fn extract_inline_tags(body: &str) -> Vec<String> {
    let mut out = vec![];
    let chars: Vec<char> = body.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        if chars[i] == '#'
            && (i == 0 || chars[i - 1].is_whitespace() || chars[i - 1] == '(')
        {
            let mut j = i + 1;
            while j < chars.len()
                && (chars[j].is_alphanumeric() || matches!(chars[j], '-' | '_' | '/'))
            {
                j += 1;
            }
            let tag: String = chars[i + 1..j].iter().collect();
            // require at least one letter, so "#123" or bare "#" are skipped
            if tag.chars().any(|c| c.is_alphabetic()) {
                out.push(tag.to_lowercase());
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wikilinks_and_tags() {
        let body = "Voir [[Note A]] et [[Note B|alias]].\n# Titre\nUn #tag-inline et #autre/sous mais pas #123.";
        assert_eq!(extract_wikilinks(body), vec!["Note A", "Note B"]);
        assert_eq!(extract_inline_tags(body), vec!["tag-inline", "autre/sous"]);
    }
}
