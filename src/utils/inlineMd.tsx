import React from "react";

// Inline-markdown rendering for one-line strings (task titles, brief lines) —
// the lightweight counterpart of the CodeMirror live preview: Todo.md keeps its
// raw markers (source of truth, Obsidian-compatible), the UI hides them.
// Handles non-nested `code`, **bold**, *italic*, ~~strike~~, [[wikilinks]] and
// [links](url). Underscore emphasis is deliberately unsupported: task titles
// may contain snake_case identifiers.

const INLINE_RE =
  /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)]+)\)/g;

/** Render a short string's inline markdown as React nodes. */
export function renderInlineMd(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index! > last) nodes.push(<span key={i++}>{text.slice(last, m.index)}</span>);
    if (m[1] != null) {
      nodes.push(
        <code key={i++} style={{
          background: "var(--card-bg)", border: "1px solid var(--border)",
          borderRadius: 4, padding: "0 4px", fontSize: "0.9em",
        }}>{m[1]}</code>
      );
    } else if (m[2] != null) {
      nodes.push(<strong key={i++} style={{ fontWeight: 600 }}>{m[2]}</strong>);
    } else if (m[3] != null) {
      nodes.push(<em key={i++}>{m[3]}</em>);
    } else if (m[4] != null) {
      nodes.push(<s key={i++}>{m[4]}</s>);
    } else if (m[5] != null) {
      // Wikilink: show the alias (or target) without brackets; navigation has
      // no target here (provenance/fiche tâche viendra avec la 2e passe).
      nodes.push(<span key={i++} style={{ color: "var(--accent)" }}>{m[6] ?? m[5]}</span>);
    } else if (m[7] != null) {
      nodes.push(<span key={i++} style={{ textDecoration: "underline" }}>{m[7]}</span>);
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) nodes.push(<span key={i++}>{text.slice(last)}</span>);
  return nodes;
}

/** Same tokens, markers stripped — for text matching (search/filters). */
export function stripInlineMd(text: string): string {
  return text.replace(INLINE_RE, (...m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[6] ?? m[5] ?? m[7] ?? "");
}
