// Obsidian-style "Live Preview" for the CodeMirror markdown editor.
//
// It walks the Lezer markdown tree and:
//   • styles constructs in place (headings sized, **bold** bold, `code`, quotes…)
//   • hides the syntax markers (#, **, `, >, - , [ ]) when the cursor isn't there
//   • re-reveals the raw markers as soon as the selection touches that construct
//     (per-line for block constructs, per-span for inline ones — like Obsidian)
//   • renders task `[ ]`/`[x]` as real, clickable checkboxes and `-` as a bullet,
//     with checked tasks struck through like the old reading mode
//   • renders [[wikilinks]] and [label](url) as clickable links (click navigates /
//     opens the browser; put the cursor on the line to edit the raw markup)
//   • makes heading sections foldable via a chevron gutter (▸), with
//     fold-all/unfold-all commands for the footer toolbar
//
// Nothing is rewritten on disk: this is purely a view layer, so the file stays
// byte-for-byte the markdown you typed.

import {
  syntaxTree, ensureSyntaxTree, foldService, foldGutter, codeFolding,
  foldEffect, unfoldEffect, foldedRanges,
} from "@codemirror/language";
import { StateField, type EditorState, type Range } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import {
  Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType,
} from "@codemirror/view";
import { t as translate } from "../../i18n";

export interface LivePreviewOptions {
  /** Called when a rendered [[wikilink]] (or relative .md link) is clicked. */
  onWikilink?: (ref: string) => void;
  /** When true, each task gets a ★ toggle that flags it important (trailing ⭐). */
  importantToggles?: boolean;
}

// ─── Static decorations ────────────────────────────────────────────────────────

const hide = Decoration.replace({});
const headingLine = [1, 2, 3, 4, 5, 6].map(n =>
  Decoration.line({ class: `cm-md-h${n}` })
);
const quoteLine = Decoration.line({ class: "cm-md-quote" });
const codeblockLine = Decoration.line({ class: "cm-md-codeblock" });
const tableRawLine = Decoration.line({ class: "cm-md-tableraw" });
const strongMark = Decoration.mark({ class: "cm-md-strong" });
const emMark = Decoration.mark({ class: "cm-md-em" });
const strikeMark = Decoration.mark({ class: "cm-md-strike" });
const codeMark = Decoration.mark({ class: "cm-md-code" });
const linkMark = Decoration.mark({ class: "cm-md-link" });
const taskDoneMark = Decoration.mark({ class: "cm-md-task-done" });

// Clickable variants carry the destination in a data attribute so the
// mousedown handler can navigate without re-parsing the document.
const wikilinkMark = (target: string) =>
  Decoration.mark({ class: "cm-md-link", attributes: { "data-wikilink": target } });
const extLinkMark = (href: string) =>
  Decoration.mark({ class: "cm-md-link", attributes: { "data-mdlink": href } });

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

class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-md-hr";
    return s;
  }
}
const hrWidget = new HrWidget();

// ─── Table widget ───────────────────────────────────────────────────────────────
// GFM tables render as a real <table> when the cursor is outside them (clicking a
// cell drops the cursor inside, which reveals the raw source, in monospace so the
// pipes stay aligned). Inline markup in cells gets a lightweight regex renderer.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Bold / italic / strike / code / links / wikilinks — enough for table cells.
function renderInline(src: string): string {
  let s = escapeHtml(src);
  s = s.replace(/`([^`]+)`/g, '<code class="cm-md-code">$1</code>');
  s = s.replace(/\[\[([^\[\]|]+)\|([^\[\]]+)\]\]/g,
    (_, t, a) => `<span class="cm-md-link" data-wikilink="${t.trim()}">${a.trim()}</span>`);
  s = s.replace(/\[\[([^\[\]|]+)\]\]/g,
    (_, t) => `<span class="cm-md-link" data-wikilink="${t.trim()}">${t.trim()}</span>`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g,
    '<span class="cm-md-link" data-mdlink="$2">$1</span>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/~~([^~]+)~~/g, '<span class="cm-md-strike">$1</span>');
  return s;
}

interface CellSpec { text: string; from: number }
interface RowSpec { cells: CellSpec[]; end: number }

class TableWidget extends WidgetType {
  constructor(
    readonly key: string, // serialized content + positions, for cheap eq()
    readonly header: CellSpec[],
    readonly aligns: (string | null)[],
    readonly rows: RowSpec[],
    readonly opts: LivePreviewOptions,
  ) { super(); }

  eq(o: TableWidget) { return o.key === this.key; }

  toDOM(view: EditorView) {
    const table = document.createElement("table");
    table.className = "cm-md-table";
    const cols = this.header.length;

    const makeCell = (tag: "th" | "td", spec: CellSpec, col: number) => {
      const cell = document.createElement(tag);
      cell.innerHTML = renderInline(spec.text.trim());
      cell.dataset.pos = String(spec.from);
      const align = this.aligns[col];
      if (align) cell.style.textAlign = align;
      return cell;
    };

    const thead = table.createTHead().insertRow();
    this.header.forEach((c, i) => thead.appendChild(makeCell("th", c, i)));

    const tbody = table.createTBody();
    for (const row of this.rows) {
      const tr = tbody.insertRow();
      for (let i = 0; i < cols; i++) {
        tr.appendChild(makeCell("td", row.cells[i] ?? { text: "", from: row.end }, i));
      }
    }

    table.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      const wiki = t.closest("[data-wikilink]");
      if (wiki) {
        e.preventDefault();
        this.opts.onWikilink?.(wiki.getAttribute("data-wikilink") ?? "");
        return;
      }
      const ext = t.closest("[data-mdlink]");
      if (ext) {
        e.preventDefault();
        const href = ext.getAttribute("data-mdlink") ?? "";
        if (href.startsWith("http://") || href.startsWith("https://")) {
          import("@tauri-apps/plugin-shell").then(({ open }) => open(href));
        } else if (href && !href.startsWith("#")) {
          this.opts.onWikilink?.(href.replace(/^\.\//, "").replace(/\.md$/i, ""));
        }
        return;
      }
      // Click on a cell → put the cursor there, revealing the raw table to edit.
      const cell = t.closest("th, td") as HTMLElement | null;
      const pos = Number(cell?.dataset.pos ?? NaN);
      if (!Number.isNaN(pos)) {
        e.preventDefault();
        view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) } });
        view.focus();
      }
    });

    return table;
  }

  ignoreEvent() { return true; } // the widget handles its own events
}

// ★ toggle appended to task lines (Tâches screen) — flips a trailing ⭐ in the source.
class StarWidget extends WidgetType {
  constructor(readonly important: boolean, readonly lineFrom: number) { super(); }
  eq(o: StarWidget) { return o.important === this.important && o.lineFrom === this.lineFrom; }
  toDOM() {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cm-md-star" + (this.important ? " cm-md-star-on" : "");
    b.textContent = this.important ? "★" : "☆";
    b.title = this.important
      ? translate("notes.livePreview.unmarkImportant")
      : translate("notes.livePreview.markImportant");
    b.dataset.line = String(this.lineFrom); // start of the task line, to find the ⭐
    return b;
  }
  ignoreEvent() { return false; }
}

// Is `pos` inside a node whose name matches `re` (walking up the tree)?
function insideNode(state: EditorState, pos: number, re: RegExp): boolean {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (re.test(n.name)) return true;
  }
  return false;
}

// Block widgets (the rendered <table>) may not be provided by a ViewPlugin, so
// tables get their own StateField, rebuilt on doc/selection changes.
function buildTableDecorations(state: EditorState, opts: LivePreviewOptions): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = state.doc;
  const sel = state.selection;
  const touches = (from: number, to: number) =>
    sel.ranges.some(r => r.from <= to && r.to >= from);
  const tree = ensureSyntaxTree(state, doc.length, 50) ?? syntaxTree(state);

  tree.iterate({
    from: 0, to: doc.length,
    enter: (node) => {
      if (node.name !== "Table") return;

      if (touches(node.from, node.to)) {
        // Cursor inside → raw source, monospace so the pipes line up.
        let pos = node.from;
        while (pos <= node.to) {
          const line = doc.lineAt(pos);
          out.push(tableRawLine.range(line.from));
          if (line.to >= node.to) break;
          pos = line.to + 1;
        }
        return false;
      }

      const table = node.node;
      const headerNode = table.getChild("TableHeader");
      if (!headerNode) return false; // malformed — leave as text
      const cellSpecs = (n: SyntaxNode): CellSpec[] =>
        n.getChildren("TableCell").map(c => ({ text: doc.sliceString(c.from, c.to), from: c.from }));
      const header = cellSpecs(headerNode);
      if (!header.length) return false;

      const delimNode = table.getChild("TableDelimiter");
      const aligns = (delimNode ? doc.sliceString(delimNode.from, delimNode.to) : "")
        .split("|").map(s => s.trim()).filter(s => s.length)
        .map(s => {
          const l = s.startsWith(":"), r = s.endsWith(":");
          return l && r ? "center" : r ? "right" : l ? "left" : null;
        });
      const rows: RowSpec[] = table.getChildren("TableRow")
        .map(r => ({ cells: cellSpecs(r), end: r.to }));

      const key = JSON.stringify({ f: node.from, a: aligns, h: header, r: rows });
      // Block replace ranges must cover whole lines (a table may be indented).
      out.push(Decoration.replace({
        widget: new TableWidget(key, header, aligns, rows, opts),
        block: true,
      }).range(doc.lineAt(node.from).from, doc.lineAt(node.to).to));
      return false;
    },
  });

  return Decoration.set(out, true);
}

function tableField(opts: LivePreviewOptions) {
  return StateField.define<DecorationSet>({
    create: state => buildTableDecorations(state, opts),
    update(value, tr) {
      if (tr.docChanged || tr.selection) return buildTableDecorations(tr.state, opts);
      return value;
    },
    provide: f => EditorView.decorations.from(f),
  });
}

// ─── Decoration builder ─────────────────────────────────────────────────────────

const wikiRe = /\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]+))?\]\]/g;

function buildDecorations(view: EditorView, opts: LivePreviewOptions): DecorationSet {
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
  const lineClass = (deco: Decoration, from: number, to: number) => {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      out.push(deco.range(line.from));
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        const name = node.name;

        if (name === "Table") return false; // rendered by the table StateField

        const h = /^ATXHeading([1-6])$/.exec(name);
        if (h) {
          out.push(headingLine[Number(h[1]) - 1].range(doc.lineAt(node.from).from));
          return; // descend to style HeaderMark + inline content
        }

        if (name === "Blockquote") {
          lineClass(quoteLine, node.from, node.to);
          return;
        }

        if (name === "FencedCode") {
          lineClass(codeblockLine, node.from, node.to);
          return; // descend so CodeMark/CodeInfo can hide the ``` fence
        }

        if (name === "HorizontalRule") {
          if (!onLine(node.from)) {
            out.push(Decoration.replace({ widget: hrWidget }).range(node.from, node.to));
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
        if (name === "EmphasisMark" || name === "StrikethroughMark" || name === "CodeMark" || name === "CodeInfo") {
          const p = node.node.parent;
          if (!(p && touches(p.from, p.to))) out.push(hide.range(node.from, node.to));
          return;
        }

        if (name === "TaskMarker") {
          const checked = /x/i.test(doc.sliceString(node.from, node.to));
          const line = doc.lineAt(node.from);
          const textStart = doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
          // Same design as the old reading mode: checked → struck + faded text.
          if (checked && line.to > textStart) {
            out.push(taskDoneMark.range(textStart, line.to));
          }
          if (!onLine(node.from)) {
            out.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) })
              .range(node.from, textStart));
            if (opts.importantToggles) {
              // Hide the raw trailing ⭐ — the ★ button is the single indicator.
              const star = /\s*⭐\s*$/.exec(doc.sliceString(line.from, line.to));
              if (star && line.from + star.index >= textStart) {
                out.push(hide.range(line.from + star.index, line.to));
              }
              out.push(Decoration.widget({ widget: new StarWidget(!!star, line.from), side: 1 })
                .range(line.to));
            }
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
            const href = text.slice(sep + 2, -1).trim().split(/\s+/)[0] ?? "";
            out.push(hide.range(node.from, textStart));          // hide "["
            out.push(extLinkMark(href).range(textStart, textEnd)); // keep + color the label
            out.push(hide.range(textEnd, node.to));              // hide "](url)"
          }
          return false; // don't descend — we handled the whole link
        }
      },
    });

    // ── [[wikilinks]] — not part of the Lezer markdown grammar, so a regex pass ──
    const text = doc.sliceString(from, to);
    wikiRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = wikiRe.exec(text))) {
      const s = from + m.index;
      const e = s + m[0].length;
      if (insideNode(state, s + 1, /Code|Table/)) continue;
      const target = m[1].trim();
      if (touches(s, e)) {
        out.push(linkMark.range(s, e)); // raw revealed, still link-colored
      } else {
        // [[target]] → show "target"; [[target|alias]] → show "alias"
        const labelFrom = m[2] ? s + 2 + m[1].length + 1 : s + 2;
        const labelTo = e - 2;
        out.push(hide.range(s, labelFrom));
        out.push(wikilinkMark(target).range(labelFrom, labelTo));
        out.push(hide.range(labelTo, e));
      }
    }
  }

  return Decoration.set(out, true);
}

// ─── Heading folding (sections collapse like the old reading mode) ─────────────

// Level of the ATX heading starting on the line [lineStart, lineEnd], or 0.
function headingLevelAt(state: EditorState, lineStart: number, lineEnd: number): number {
  let level = 0;
  syntaxTree(state).iterate({
    from: lineStart, to: Math.min(lineEnd, lineStart + 4),
    enter: (node) => {
      const h = /^ATXHeading([1-6])$/.exec(node.name);
      if (h && node.from >= lineStart && node.from <= lineEnd) level = Number(h[1]);
    },
  });
  return level;
}

// End of the section owned by a heading of `level` whose line ends at `from`:
// everything until the next heading of the same or higher rank.
function sectionEnd(state: EditorState, from: number, level: number): number {
  let end = state.doc.length;
  let found = false;
  syntaxTree(state).iterate({
    from, to: state.doc.length,
    enter: (node) => {
      if (found) return false;
      const h = /^ATXHeading([1-6])$/.exec(node.name);
      if (h && node.from > from && Number(h[1]) <= level) {
        end = state.doc.lineAt(node.from).from - 1;
        found = true;
        return false;
      }
    },
  });
  return end;
}

function headingFoldRange(state: EditorState, lineStart: number, lineEnd: number) {
  const level = headingLevelAt(state, lineStart, lineEnd);
  if (!level) return null;
  const end = sectionEnd(state, lineEnd, level);
  // Foldable only if something non-blank actually sits under the heading.
  if (end <= lineEnd || !/\S/.test(state.doc.sliceString(lineEnd, end))) return null;
  return { from: lineEnd, to: end };
}

const headingFolding = foldService.of(headingFoldRange);

function foldMarker(open: boolean): HTMLElement {
  const s = document.createElement("span");
  s.className = "cm-md-foldmarker" + (open ? " cm-md-open" : "");
  s.textContent = "▸";
  s.title = open ? translate("notes.livePreview.collapseSection") : translate("notes.livePreview.expandSection");
  return s;
}

function computeHeadingFolds(state: EditorState): { from: number; to: number }[] {
  const headings: { lineStart: number; lineEnd: number }[] = [];
  syntaxTree(state).iterate({
    from: 0, to: state.doc.length,
    enter: (node) => {
      if (/^ATXHeading[1-6]$/.test(node.name)) {
        const line = state.doc.lineAt(node.from);
        headings.push({ lineStart: line.from, lineEnd: line.to });
      }
    },
  });
  const folds: { from: number; to: number }[] = [];
  for (const h of headings) {
    const range = headingFoldRange(state, h.lineStart, h.lineEnd);
    if (range) folds.push(range);
  }
  return folds;
}

/** Folds every heading section; if they are all already folded, unfolds
 *  everything instead. Returns true if the sections are now all folded. */
export function toggleAllHeadingFolds(view: EditorView): boolean {
  const folds = computeHeadingFolds(view.state);
  if (!folds.length) return false;

  const folded = foldedRanges(view.state);
  const isFolded = (r: { from: number; to: number }) => {
    let hit = false;
    folded.between(r.from, r.to, (f, t) => { if (f === r.from && t === r.to) hit = true; });
    return hit;
  };

  if (folds.every(isFolded)) {
    const effects: ReturnType<typeof unfoldEffect.of>[] = [];
    folded.between(0, view.state.doc.length, (f, t) => {
      effects.push(unfoldEffect.of({ from: f, to: t }));
    });
    view.dispatch({ effects });
    return false;
  }
  view.dispatch({ effects: folds.filter(r => !isFolded(r)).map(r => foldEffect.of(r)) });
  return true;
}

// ─── Plugin + click handling + theme ────────────────────────────────────────────

function livePreviewPlugin(opts: LivePreviewOptions) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = buildDecorations(view, opts); }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) {
          this.decorations = buildDecorations(u.view, opts);
        }
      }
    },
    { decorations: v => v.decorations }
  );
}

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

// Toggle a task's "important" flag by adding/removing the trailing ⭐ in the source.
const starClicks = EditorView.domEventHandlers({
  mousedown(e, view) {
    const t = e.target as HTMLElement;
    if (t.nodeName !== "BUTTON" || !t.classList.contains("cm-md-star")) return false;
    const lineFrom = Number(t.dataset.line);
    if (Number.isNaN(lineFrom) || lineFrom > view.state.doc.length) return false;
    const line = view.state.doc.lineAt(lineFrom);
    const star = /\s*⭐\s*$/.exec(line.text);
    if (star) {
      view.dispatch({ changes: { from: line.from + star.index, to: line.to } });
    } else {
      view.dispatch({ changes: { from: line.to, insert: " ⭐" } });
    }
    e.preventDefault();
    return true;
  },
});

// Rendered links navigate on click (raw ones — cursor on the span — edit normally).
function linkClicks(opts: LivePreviewOptions) {
  return EditorView.domEventHandlers({
    mousedown(e) {
      const el = (e.target as HTMLElement).closest?.("[data-wikilink], [data-mdlink]");
      if (!el) return false;
      e.preventDefault();
      const wiki = el.getAttribute("data-wikilink");
      if (wiki) {
        opts.onWikilink?.(wiki);
        return true;
      }
      const href = el.getAttribute("data-mdlink") ?? "";
      if (href.startsWith("http://") || href.startsWith("https://")) {
        import("@tauri-apps/plugin-shell").then(({ open }) => open(href));
      } else if (href && !href.startsWith("#")) {
        // Relative link to another note → same navigation as a wikilink.
        opts.onWikilink?.(href.replace(/^\.\//, "").replace(/\.md$/i, ""));
      }
      return true;
    },
  });
}

const liveTheme = EditorView.theme({
  "&": { backgroundColor: "var(--card-bg)", color: "var(--text-primary)" },
  ".cm-content": {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
    fontSize: "14px", lineHeight: "1.7", padding: "24px 32px", caretColor: "var(--accent)",
    maxWidth: "720px",
  },
  ".cm-md-h1": {
    fontSize: "26px", fontWeight: "700", lineHeight: "1.35",
    paddingBottom: "8px", borderBottom: "1px solid var(--border)",
  },
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
  ".cm-md-codeblock": {
    fontFamily: "'SF Mono', 'Menlo', monospace", fontSize: "12px",
    backgroundColor: "#1C1C1C", color: "#F0E6D3", padding: "0 16px",
  },
  ".cm-md-link": {
    color: "#C8914A", cursor: "pointer", textDecoration: "none",
    borderBottom: "1px solid rgba(200,145,74,0.4)",
  },
  ".cm-md-quote": {
    borderLeft: "3px solid var(--accent)", paddingLeft: "12px",
    color: "var(--text-secondary)", backgroundColor: "var(--active-bg)",
  },
  ".cm-md-bullet": { color: "var(--accent)", paddingRight: "2px" },
  ".cm-md-task": {
    width: "14px", height: "14px", marginRight: "8px",
    accentColor: "#C8914A", cursor: "pointer", verticalAlign: "middle",
  },
  ".cm-md-task-done": { textDecoration: "line-through", opacity: "0.5" },
  ".cm-md-star": {
    background: "none", border: "none", cursor: "pointer", fontSize: "14px",
    lineHeight: "1", marginLeft: "8px", padding: "0", verticalAlign: "middle",
    color: "var(--text-muted)",
  },
  ".cm-md-star.cm-md-star-on": { color: "#E0A93A" },
  ".cm-md-hr": {
    display: "inline-block", width: "100%", verticalAlign: "middle",
    borderTop: "1px solid var(--border)",
  },
  // Rendered GFM tables (same design as the old reading mode).
  ".cm-md-table": {
    borderCollapse: "collapse", width: "100%", margin: "6px 0",
  },
  ".cm-md-table th, .cm-md-table td": {
    border: "1px solid var(--border)", padding: "6px 12px",
    textAlign: "left", cursor: "text",
  },
  ".cm-md-table th": { backgroundColor: "var(--bg)", fontWeight: "600" },
  // Raw table source (cursor inside): monospace keeps the pipes aligned.
  ".cm-md-tableraw": {
    fontFamily: "'SF Mono', 'Menlo', monospace", fontSize: "12.5px",
  },
  // Fold gutter: transparent, chevrons like the old reading mode.
  ".cm-gutters": { backgroundColor: "transparent", border: "none" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 0 0 8px" },
  ".cm-md-foldmarker": {
    display: "inline-block", fontSize: "0.72em", lineHeight: "1.7",
    color: "var(--text-muted)", cursor: "pointer",
    transition: "transform 0.15s ease, color 0.15s ease",
  },
  ".cm-md-foldmarker.cm-md-open": { transform: "rotate(90deg)" },
  ".cm-md-foldmarker:hover": { color: "var(--accent)" },
  ".cm-foldPlaceholder": {
    background: "var(--active-bg)", border: "none", color: "var(--text-muted)",
    borderRadius: "4px", padding: "0 6px", margin: "0 4px", cursor: "pointer",
  },
});

// Plugin order matters: theme first, then click handlers, then the decorating plugin.
export function markdownLivePreview(opts: LivePreviewOptions = {}) {
  return [
    liveTheme,
    codeFolding({ placeholderText: "…" }),
    headingFolding,
    foldGutter({ markerDOM: foldMarker }),
    checkboxClicks,
    starClicks,
    linkClicks(opts),
    tableField(opts),
    livePreviewPlugin(opts),
  ];
}
