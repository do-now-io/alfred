import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { MdEdit } from "react-icons/md";
import { parseTasks } from "../../utils/todoTasks";

// react-markdown sanitizes hrefs and strips unknown protocols (only http/https/
// mailto/… survive) — without this, wikilink: anchors render with href=""
function urlTransform(url: string): string {
  return url.startsWith("wikilink:") ? url : defaultUrlTransform(url);
}

// encodeURIComponent leaves ( ) untouched, which would break [x](url) syntax
function encodeRef(ref: string): string {
  return encodeURIComponent(ref).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function resolveWikilinks(text: string): string {
  let count = 0;
  const resolved = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
    count++;
    const display = (alias?.trim() ?? target.trim()).replace(/"/g, "&quot;");
    const ref = target.trim().replace(/"/g, "&quot;");
    return `[${display}](wikilink:${encodeRef(ref)})`;
  });
  console.log(`[wikilink] NotePreview: ${count} wikilink(s) detected in body`);
  return resolved;
}

interface Props {
  body: string;
  onWikilink?: (ref: string) => void;
  onToggleCheckbox?: (index: number) => void;
  /** When provided, each task gets a ★ toggle to flag it important. */
  onToggleImportant?: (index: number) => void;
}

// Imperative API for "fold/unfold every section at once" from a parent toolbar.
export interface NotePreviewHandle {
  collapseAll: () => void;
  expandAll: () => void;
  /** Toggles all sections; returns true if they are now all collapsed. */
  toggleAll: () => boolean;
  hasFoldableHeadings: () => boolean;
}

const NotePreview = forwardRef<NotePreviewHandle, Props>(function NotePreview(
  { body, onWikilink, onToggleCheckbox, onToggleImportant }, ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onWikilinkRef     = useRef(onWikilink);
  const onToggleRef       = useRef(onToggleCheckbox);
  const onImportantRef    = useRef(onToggleImportant);
  onWikilinkRef.current   = onWikilink;
  onToggleRef.current     = onToggleCheckbox;
  onImportantRef.current  = onToggleImportant;
  // Keys of currently-folded headings — kept in a ref so the fold state survives
  // re-renders (e.g. when toggling a checkbox rebuilds the markdown).
  const collapsedRef = useRef<Set<string>>(new Set());
  // Set by the effect each render, so the imperative API can drive folding.
  const reapplyRef = useRef<(() => void) | null>(null);
  const foldableKeysRef = useRef<string[]>([]);

  // Runs after every render — wires up interactivity directly on DOM elements
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // ── Checkboxes (+ optional ★ "important" toggle) ─────────────────────
    const tasks = onImportantRef.current ? parseTasks(body) : [];
    const boxes = el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    boxes.forEach((cb, idx) => {
      cb.removeAttribute("disabled");
      cb.style.cursor        = "pointer";
      cb.style.pointerEvents = "auto";
      cb.style.accentColor   = "#C8914A";
      cb.style.width         = "14px";
      cb.style.height        = "14px";

      // Apply strike-through style based on current checked state
      const li = cb.closest("li");
      const label = li?.querySelector<HTMLElement>("p, span") ?? li ?? null;
      const applyStyle = (checked: boolean) => {
        if (!label) return;
        label.style.textDecoration = checked ? "line-through" : "none";
        label.style.opacity        = checked ? "0.5"          : "1";
      };
      applyStyle(cb.checked);

      cb.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Toggle DOM state immediately — no wait for React re-render
        const newChecked = !cb.checked;
        cb.checked = newChecked;
        applyStyle(newChecked);
        // Propagate to React state (will eventually re-render in sync)
        onToggleRef.current?.(idx);
      };

      // ── ★ "important" toggle ───────────────────────────────────────────
      if (onImportantRef.current && li) {
        const important = tasks[idx]?.important ?? false;

        // Hide the raw "⭐" that sits at the end of the task text — the button
        // below is the single visible indicator.
        if (important) {
          const texts: Text[] = [];
          const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) texts.push(walker.currentNode as Text);
          const last = texts[texts.length - 1];
          if (last && /⭐\s*$/.test(last.nodeValue ?? "")) {
            last.nodeValue = (last.nodeValue ?? "").replace(/\s*⭐\s*$/, "");
          }
        }

        // Reuse an existing button across renders to avoid duplicates.
        let flag = li.querySelector<HTMLButtonElement>("button.alfred-flag");
        if (!flag) {
          flag = document.createElement("button");
          flag.className = "alfred-flag";
          flag.type = "button";
          li.appendChild(flag);
        }
        flag.textContent = important ? "★" : "☆";
        flag.title = important ? "Retirer des importantes" : "Marquer comme importante";
        flag.style.cssText =
          `background:none;border:none;cursor:pointer;font-size:14px;line-height:1;` +
          `margin-left:8px;padding:0;vertical-align:middle;` +
          `color:${important ? "#E0A93A" : "var(--text-muted)"};`;
        flag.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          onImportantRef.current?.(idx);
        };
      }
    });

    // ── Links & wikilinks ────────────────────────────────────────────────
    const anchors = el.querySelectorAll<HTMLAnchorElement>("a");
    console.log(`[wikilink] NotePreview: wiring ${anchors.length} anchor(s)`);
    anchors.forEach((a) => {
      const href = a.getAttribute("href") ?? "";
      console.log(`[wikilink] NotePreview: anchor href="${href}" text="${a.textContent}"`);
      a.style.color  = "#C8914A";
      a.style.cursor = "pointer";
      a.style.borderBottom = "1px solid rgba(200,145,74,0.4)";
      a.style.textDecoration = "none";

      a.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        console.log(`[wikilink] NotePreview: click on href="${href}"`);
        if (href.startsWith("wikilink:")) {
          const ref = decodeURIComponent(href.replace("wikilink:", ""));
          console.log(`[wikilink] NotePreview: resolved ref="${ref}"`);
          onWikilinkRef.current?.(ref);
        } else if (href.startsWith("http://") || href.startsWith("https://")) {
          import("@tauri-apps/plugin-shell").then(({ open }) => open(href));
        } else if (href && !href.startsWith("#")) {
          const ref = href.replace(/^\.\//, "").replace(/\.md$/i, "");
          onWikilinkRef.current?.(ref);
        }
      };
    });

    // ── Collapsible headings ─────────────────────────────────────────────
    // Click a heading to fold/unfold its whole section: every block that follows
    // it until the next heading of the same or higher rank. Nesting is handled by
    // a single linear pass (`reapply`), so folding an outer heading hides inner
    // ones, and re-opening it restores any inner folds that were still collapsed.
    reapplyRef.current = null;
    foldableKeysRef.current = [];
    const root = el.querySelector<HTMLElement>(".alfred-preview");
    if (root) {
      const blocks = Array.from(root.children) as HTMLElement[];
      const isHeading = (n: HTMLElement) => /^H[1-6]$/.test(n.tagName);
      const collapsed = collapsedRef.current;
      const foldableKeys: string[] = [];

      const reapply = () => {
        let hideUntilLevel = 0; // 0 = visible; else hide blocks until a heading ≤ this level
        for (const node of blocks) {
          if (isHeading(node)) {
            const level = Number(node.tagName[1]);
            if (hideUntilLevel && level <= hideUntilLevel) hideUntilLevel = 0; // section ended
            const hidden = hideUntilLevel !== 0;
            node.style.display = hidden ? "none" : "";
            const isCollapsed = collapsed.has(node.dataset.foldKey ?? "");
            node.classList.toggle("alfred-collapsed", isCollapsed);
            if (isCollapsed && !hidden) hideUntilLevel = level; // open a new hidden region
          } else {
            node.style.display = hideUntilLevel !== 0 ? "none" : "";
          }
        }
      };

      let headingIdx = 0;
      blocks.forEach((node, i) => {
        if (!isHeading(node)) return;
        const level = Number(node.tagName[1]);
        // Stable-ish key so the fold state maps back to the same heading across renders.
        const key = `${headingIdx++}|${node.textContent ?? ""}`;
        node.dataset.foldKey = key;

        // Foldable only if something actually sits under it.
        const next = blocks[i + 1];
        const foldable = !!next && !(isHeading(next) && Number(next.tagName[1]) <= level);
        if (!foldable) {
          node.classList.remove("alfred-foldable");
          node.onclick = null;
          return;
        }

        node.classList.add("alfred-foldable");
        foldableKeys.push(key);
        node.onclick = (e) => {
          if ((e.target as HTMLElement).closest("a")) return; // let links win
          if (collapsed.has(key)) collapsed.delete(key);
          else collapsed.add(key);
          reapply();
        };
      });

      reapply();
      reapplyRef.current = reapply;
      foldableKeysRef.current = foldableKeys;
    }
  }); // no deps — runs after every render

  useImperativeHandle(ref, () => ({
    collapseAll() {
      foldableKeysRef.current.forEach(k => collapsedRef.current.add(k));
      reapplyRef.current?.();
    },
    expandAll() {
      collapsedRef.current.clear();
      reapplyRef.current?.();
    },
    toggleAll() {
      const keys = foldableKeysRef.current;
      const allCollapsed = keys.length > 0 && keys.every(k => collapsedRef.current.has(k));
      if (allCollapsed) collapsedRef.current.clear();
      else keys.forEach(k => collapsedRef.current.add(k));
      reapplyRef.current?.();
      return !allCollapsed;
    },
    hasFoldableHeadings() {
      return foldableKeysRef.current.length > 0;
    },
  }), []);

  if (!body.trim()) {
    return (
      <div style={{ padding: "24px", color: "var(--text-muted)", fontSize: 14, fontStyle: "italic" }}>
        Note vide — cliquez sur <MdEdit style={{ verticalAlign: "middle" }} /> pour commencer à écrire.
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ padding: "24px 32px", overflowY: "auto", height: "100%" }}>
      <style>{PREVIEW_CSS}</style>
      <div className="alfred-preview">
        <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform}>
          {resolveWikilinks(body)}
        </ReactMarkdown>
      </div>
    </div>
  );
});

export default NotePreview;

const PREVIEW_CSS = `
.alfred-preview {
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
  font-size: 14px; line-height: 1.7; color: var(--text-primary); max-width: 720px;
}
.alfred-preview h1 {
  font-size: 26px; font-weight: 700; color: var(--text-primary);
  margin: 0 0 20px; padding-bottom: 8px; border-bottom: 1px solid var(--border);
}
.alfred-preview h2 { font-size: 19px; font-weight: 600; color: var(--text-primary); margin: 24px 0 10px; }
.alfred-preview h3 { font-size: 16px; font-weight: 600; color: var(--text-primary); margin: 18px 0 8px; }
.alfred-preview .alfred-foldable { cursor: pointer; position: relative; }
.alfred-preview .alfred-foldable::before {
  content: "▸";
  position: absolute; left: -1.05em; top: 50%;
  font-size: 0.72em; line-height: 1; color: var(--text-muted);
  transform: translateY(-50%) rotate(90deg); transform-origin: center;
  transition: transform 0.15s ease, color 0.15s ease;
}
.alfred-preview .alfred-foldable.alfred-collapsed::before { transform: translateY(-50%) rotate(0deg); }
.alfred-preview .alfred-foldable:hover::before { color: var(--accent); }
.alfred-preview a { color: #C8914A; text-decoration: none; cursor: pointer; }
.alfred-preview p { margin: 0 0 12px; }
.alfred-preview blockquote {
  margin: 12px 0; padding: 8px 16px;
  border-left: 3px solid #C8914A; background: var(--active-bg);
  border-radius: 0 6px 6px 0; color: var(--text-secondary);
}
.alfred-preview code {
  background: var(--active-bg); color: #8B5E2A;
  padding: 1px 5px; border-radius: 4px;
  font-family: 'SF Mono', 'Menlo', monospace; font-size: 12px;
}
.alfred-preview pre {
  background: #1C1C1C; color: #F0E6D3;
  padding: 16px; border-radius: 8px; overflow-x: auto; margin: 12px 0;
}
.alfred-preview pre code { background: none; color: inherit; padding: 0; }
.alfred-preview ul, .alfred-preview ol { margin: 0 0 12px; padding-left: 24px; }
.alfred-preview li { margin-bottom: 4px; }
.alfred-preview li p { margin: 0; }
.alfred-preview ul.contains-task-list { list-style: none; padding-left: 4px; }
/* Keep the item in normal inline flow — a flex container would split the text
   around inline markup (**bold**, links) into separate columns. The checkbox
   hangs in a left gutter so wrapped lines stay aligned. */
.alfred-preview li.task-list-item { display: block; padding-left: 24px; }
.alfred-preview li.task-list-item > input[type="checkbox"] {
  margin-left: -24px; margin-right: 8px; vertical-align: middle;
}
.alfred-preview hr { border: none; border-top: 1px solid var(--border); margin: 24px 0; }
.alfred-preview table { border-collapse: collapse; width: 100%; margin: 12px 0; }
.alfred-preview th, .alfred-preview td { border: 1px solid var(--border); padding: 6px 12px; text-align: left; }
.alfred-preview th { background: var(--bg); font-weight: 600; }
`;
