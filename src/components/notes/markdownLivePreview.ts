// Obsidian-style "Live Preview" for the CodeMirror markdown editor.
//
// It walks the Lezer markdown tree and:
//   • styles constructs in place (headings sized, **bold** bold, `code`, quotes…)
//   • hides the syntax markers (#, **, `, >, - , [ ]) when the cursor isn't there
//   • re-reveals the raw markers as soon as the selection touches that construct
//     (per-line for block constructs, per-span for inline ones — like Obsidian)
//   • renders task `[ ]`/`[x]` as real, clickable checkboxes and `-` as a bullet
//
// Nothing is rewritten on disk: this is purely a view layer, so the file stays
// byte-for-byte the markdown you typed.

import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import {
  Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType,
} from "@codemirror/view";

// ─── Static decorations ────────────────────────────────────────────────────────

const hide = Decoration.replace({});
const headingLine = [1, 2, 3, 4, 5, 6].map(n =>
  Decoration.line({ class: `cm-md-h${n}` })
);
const quoteLine = Decoration.line({ class: "cm-md-quote" });
const strongMark = Decoration.mark({ class: "cm-md-strong" });
const emMark = Decoration.mark({ class: "cm-md-em" });
const strikeMark = Decoration.mark({ class: "cm-md-strike" });
const codeMark = Decoration.mark({ class: "cm-md-code" });
const linkMark = Decoration.mark({ class: "cm-md-link" });

// ─── Widgets ────────────────────────────────────────────────────────────────────

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) { super(); }
  eq(o: CheckboxWidget) { return o.checked === this.checked && o.pos === this.pos; }
  toDOM() {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.className = "cm-md-task";
    input.dataset.pos = String(this.pos); // position of the '[' so the click can flip it
    return input;
  }
  ignoreEvent() { return false; }
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-md-bullet";
    s.textContent = "•";
    return s;
  }
}
const bulletWidget = new BulletWidget();

// ─── Decoration builder ─────────────────────────────────────────────────────────

function buildDecorations(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  const { state } = view;
  const doc = state.doc;
  const sel = state.selection;

  // any selection range overlaps [from, to]
  const touches = (from: number, to: number) =>
    sel.ranges.some(r => r.from <= to && r.to >= from);
  // is a selection on the line that contains `pos`?
  const onLine = (pos: number) => {
    const line = doc.lineAt(pos);
    return touches(line.from, line.to);
  };
  // hide a marker plus a single trailing space, if present
  const hideWithSpace = (from: number, to: number) => {
    const end = doc.sliceString(to, to + 1) === " " ? to + 1 : to;
    out.push(hide.range(from, end));
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        const name = node.name;

        const h = /^ATXHeading([1-6])$/.exec(name);
        if (h) {
          out.push(headingLine[Number(h[1]) - 1].range(doc.lineAt(node.from).from));
          return; // descend to style HeaderMark + inline content
        }

        if (name === "Blockquote") {
          let pos = node.from;
          while (pos <= node.to) {
            const line = doc.lineAt(pos);
            out.push(quoteLine.range(line.from));
            if (line.to >= node.to) break;
            pos = line.to + 1;
          }
          return;
        }

        if (name === "StrongEmphasis") { out.push(strongMark.range(node.from, node.to)); return; }
        if (name === "Emphasis")       { out.push(emMark.range(node.from, node.to)); return; }
        if (name === "Strikethrough")  { out.push(strikeMark.range(node.from, node.to)); return; }
        if (name === "InlineCode")     { out.push(codeMark.range(node.from, node.to)); return; }

        if (name === "HeaderMark") {
          if (!onLine(node.from)) hideWithSpace(node.from, node.to);
          return;
        }
        if (name === "QuoteMark") {
          if (!onLine(node.from)) hideWithSpace(node.from, node.to);
          return;
        }
        if (name === "EmphasisMark" || name === "StrikethroughMark" || name === "CodeMark") {
          const p = node.node.parent;
          if (!(p && touches(p.from, p.to))) out.push(hide.range(node.from, node.to));
          return;
        }

        if (name === "TaskMarker") {
          if (!onLine(node.from)) {
            const checked = /x/i.test(doc.sliceString(node.from, node.to));
            const end = doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
            out.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) })
              .range(node.from, end));
          }
          return;
        }

        if (name === "ListMark") {
          if (onLine(node.from)) return;
          const mark = doc.sliceString(node.from, node.to);
          const isBullet = mark === "-" || mark === "*" || mark === "+";
          const rest = doc.sliceString(node.to, Math.min(node.to + 6, doc.length));
          const isTask = /^\s*\[[ xX]\]/.test(rest);
          if (isTask) hideWithSpace(node.from, node.to);          // checkbox replaces the marker
          else if (isBullet) out.push(Decoration.replace({ widget: bulletWidget }).range(node.from, node.to));
          return;
        }

        if (name === "Link") {
          const text = doc.sliceString(node.from, node.to);
          const sep = text.indexOf("](");
          if (text.startsWith("[") && sep > 1 && !touches(node.from, node.to)) {
            const textStart = node.from + 1;
            const textEnd = node.from + sep;
            out.push(hide.range(node.from, textStart));        // hide "["
            out.push(linkMark.range(textStart, textEnd));      // keep + color the label
            out.push(hide.range(textEnd, node.to));            // hide "](url)"
          }
          return false; // don't descend — we handled the whole link
        }
      },
    });
  }

  return Decoration.set(out, true);
}

// ─── Plugin + click handling + theme ────────────────────────────────────────────

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildDecorations(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: v => v.decorations }
);

// Toggle a task checkbox by flipping the char between its brackets, in the source.
const checkboxClicks = EditorView.domEventHandlers({
  mousedown(e, view) {
    const t = e.target as HTMLElement;
    if (t.nodeName !== "INPUT" || !t.classList.contains("cm-md-task")) return false;
    const pos = Number((t as HTMLInputElement).dataset.pos);
    if (Number.isNaN(pos)) return false;
    const cur = view.state.doc.sliceString(pos, pos + 3); // "[ ]" or "[x]"
    const checked = /\[[xX]\]/.test(cur);
    view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: checked ? " " : "x" } });
    e.preventDefault();
    return true;
  },
});

const liveTheme = EditorView.theme({
  "&": { backgroundColor: "var(--card-bg)", color: "var(--text-primary)" },
  ".cm-content": {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
    fontSize: "14px", lineHeight: "1.7", padding: "24px 32px", caretColor: "var(--accent)",
  },
  ".cm-md-h1": { fontSize: "26px", fontWeight: "700", lineHeight: "1.35" },
  ".cm-md-h2": { fontSize: "19px", fontWeight: "600", lineHeight: "1.35" },
  ".cm-md-h3": { fontSize: "16px", fontWeight: "600" },
  ".cm-md-h4, & .cm-md-h5, & .cm-md-h6": { fontSize: "14px", fontWeight: "600" },
  ".cm-md-strong": { fontWeight: "600", color: "var(--text-primary)" },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-strike": { textDecoration: "line-through", opacity: "0.65" },
  ".cm-md-code": {
    fontFamily: "'SF Mono', 'Menlo', monospace", fontSize: "0.85em",
    backgroundColor: "var(--active-bg)", color: "#8B5E2A",
    padding: "1px 5px", borderRadius: "4px",
  },
  ".cm-md-link": { color: "var(--accent)", textDecoration: "underline", textDecorationColor: "rgba(200,145,74,0.4)" },
  ".cm-md-quote": {
    borderLeft: "3px solid var(--accent)", paddingLeft: "12px",
    color: "var(--text-secondary)", backgroundColor: "var(--active-bg)",
  },
  ".cm-md-bullet": { color: "var(--accent)", paddingRight: "2px" },
  ".cm-md-task": { marginRight: "6px", accentColor: "#C8914A", cursor: "pointer", verticalAlign: "middle" },
});

// Plugin order matters: theme first, then click handler, then the decorating plugin.
export const markdownLivePreview = [liveTheme, checkboxClicks, livePreviewPlugin];
