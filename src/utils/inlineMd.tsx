import React from "react";
import { encodeLinkRef } from "./linkRef";

// Inline-markdown rendering for one-line strings (task titles, brief lines) —
// the lightweight counterpart of the CodeMirror live preview: Todo.md keeps its
// raw markers (source of truth, Obsidian-compatible), the UI hides them.
// Handles non-nested `code`, **bold**, *italic*, ~~strike~~, [[wikilinks]] and
// [links](url). Underscore emphasis is deliberately unsupported: task titles
// may contain snake_case identifiers.

const INLINE_RE =
  /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)]+)\)/g;

const linkStyle: React.CSSProperties = {
  color: "var(--accent)", cursor: "pointer", background: "none", border: "none",
  padding: 0, font: "inherit", textDecoration: "underline", textDecorationColor: "rgba(200,145,74,0.4)",
};

/** Render a short string's inline markdown as React nodes. `onNavigate`
 *  (spec/23) makes `[[wikilinks]]` and `[text](url)` clickable — same href
 *  convention as `BriefingContent` (`wikilink:<ref>`, `task:<ref>`, or a raw
 *  `http(s)://`/other url as literally typed). Without it, links render as
 *  plain (non-interactive) styled text — the historical dead-span behavior. */
export function renderInlineMd(text: string, onNavigate?: (href: string) => void): React.ReactNode[] {
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
      const target = m[5];
      const label = m[6] ?? m[5];
      nodes.push(
        onNavigate ? (
          <button key={i++} style={linkStyle} onClick={(e) => { e.stopPropagation(); onNavigate(`wikilink:${encodeLinkRef(target)}`); }}>
            {label}
          </button>
        ) : (
          <span key={i++} style={{ color: "var(--accent)" }}>{label}</span>
        )
      );
    } else if (m[7] != null) {
      const label = m[7];
      const url = m[8];
      nodes.push(
        onNavigate ? (
          <button key={i++} style={linkStyle} onClick={(e) => { e.stopPropagation(); onNavigate(url); }}>
            {label}
          </button>
        ) : (
          <span key={i++} style={{ textDecoration: "underline" }}>{label}</span>
        )
      );
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
