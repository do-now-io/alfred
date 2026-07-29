import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import { markdownLivePreview, toggleAllHeadingFolds } from "./markdownLivePreview";
import { useT, useI18nStore } from "../../i18n";

// Labels for the CodeMirror search panel (spec/07/21 — recherche in-file).
// `@codemirror/search`'s phrase-override API (`EditorState.phrases.of`) takes a
// `Record<originalEnglishPhrase, replacement>`: passing a French map replaces
// the panel's English defaults, and passing nothing leaves them as-is — so in
// English we simply don't add the extension (no need for an identity map).
function buildFrenchPhrases(t: (key: string) => string): Record<string, string> {
  return {
    "Find": t("notes.editor.search.find"),
    "Replace": t("notes.editor.search.replace"),
    "next": t("notes.editor.search.next"),
    "previous": t("notes.editor.search.previous"),
    "all": t("notes.editor.search.all"),
    "match case": t("notes.editor.search.matchCase"),
    "by word": t("notes.editor.search.byWord"),
    "regexp": t("notes.editor.search.regexp"),
    "replace": t("notes.editor.search.replaceOne"),
    "replace all": t("notes.editor.search.replaceAll"),
    "close": t("notes.editor.search.close"),
    "current match": t("notes.editor.search.currentMatch"),
    "replaced $ matches": t("notes.editor.search.replacedMatches"),
    "replaced match on line $": t("notes.editor.search.replacedMatchOnLine"),
    "on line": t("notes.editor.search.onLine"),
    "Go to line": t("notes.editor.search.goToLine"),
    "go": t("notes.editor.search.go"),
  };
}

interface Props {
  body: string;
  noteKey: string; // used to reset editor when note changes
  onChange: (body: string) => void;
  onWikilink?: (ref: string) => void;
  /** `task:<ref>` links (spec/23, the compte-rendu's "Tâches" section) — pass
   *  `useInternalLink()`'s handler directly, same contract. */
  onNavigate?: (href: string) => void;
  /** When true, each task gets a ★ toggle to flag it important (Tâches screen). */
  importantToggles?: boolean;
  /** First matching occurrence gets highlighted + scrolled into view — `null`/
   *  absent clears it (`/resolve`, feedback tests: hovering a to-verify card
   *  now highlights its quote in the transcription instead of leaving the
   *  reader to search for it by eye). Case-insensitive fallback, same matching
   *  as `replaceOnce` (Resolve.tsx) so "found" here implies "found" there too. */
  highlightQuote?: string | null;
}

const setHighlightEffect = StateEffect.define<{ from: number; to: number } | null>();
const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setHighlightEffect)) {
        deco = e.value
          ? Decoration.set([Decoration.mark({ class: "cm-quote-highlight" }).range(e.value.from, e.value.to)])
          : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Imperative API for "fold/unfold every section at once" from a parent toolbar.
export interface NoteEditorHandle {
  /** Toggles all heading sections; returns true if they are now all folded. */
  toggleAll: () => boolean;
  /** Opens the in-file search panel (Ctrl/Cmd+F equivalent). */
  openSearch: () => void;
}

const NoteEditor = forwardRef<NoteEditorHandle, Props>(function NoteEditor(
  { body, noteKey, onChange, onWikilink, onNavigate, importantToggles, highlightQuote }, ref
) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onWikilinkRef = useRef(onWikilink);
  onWikilinkRef.current = onWikilink;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  useImperativeHandle(ref, () => ({
    toggleAll() {
      return viewRef.current ? toggleAllHeadingFolds(viewRef.current) : false;
    },
    openSearch() {
      if (viewRef.current) openSearchPanel(viewRef.current);
    },
  }), []);

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: body,
      extensions: [
        history(),
        // searchKeymap first so Escape closes the search panel before the
        // default Escape binding runs (it yields when no panel is open).
        keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]),
        // GFM-enabled parsing (task lists, strikethrough, tables) for the live preview.
        markdown({ base: markdownLanguage }),
        markdownLivePreview({
          onWikilink: r => onWikilinkRef.current?.(r),
          onNavigate: href => onNavigateRef.current?.(href),
          importantToggles,
        }),
        placeholder(t("notes.editor.placeholder")),
        search({ top: true }),
        highlightSelectionMatches(),
        highlightField,
        // English is the search panel's own default — only override the
        // phrases when the app is in French (spec/21).
        ...(lang === "fr" ? [EditorState.phrases.of(buildFrenchPhrases(t))] : []),
        EditorView.lineWrapping,
        EditorView.updateListener.of(update => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-focused": { outline: "none" },
          ".cm-editor": { height: "100%" },
          ".cm-scroller": { fontFamily: "inherit" },
          ".cm-panels": { background: "var(--card-bg)", color: "var(--text-primary)" },
          ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
          ".cm-panel.cm-search": { padding: "6px 10px", fontSize: "12.5px" },
          ".cm-panel.cm-search .cm-textfield": {
            background: "var(--bg)", border: "1px solid var(--border)",
            borderRadius: "6px", color: "var(--text-primary)",
          },
          ".cm-panel.cm-search .cm-button": {
            background: "transparent", backgroundImage: "none",
            border: "1px solid var(--border)", borderRadius: "6px",
            color: "var(--text-primary)", cursor: "pointer",
          },
          ".cm-panel.cm-search label": { color: "var(--text-secondary)" },
          ".cm-panel.cm-search [name=close]": {
            color: "var(--text-muted)", fontSize: "16px", cursor: "pointer",
          },
          ".cm-searchMatch": { background: "rgba(200, 145, 74, 0.25)" },
          ".cm-searchMatch.cm-searchMatch-selected": { background: "rgba(200, 145, 74, 0.5)" },
          ".cm-quote-highlight": { background: "rgba(200, 145, 74, 0.45)", borderRadius: "3px" },
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    view.focus();

    return () => { view.destroy(); viewRef.current = null; };
  }, [noteKey, lang]); // remount when note changes, or when the language changes (spec/21)

  // The editor owns the document; edits flow out through onChange, so `body`
  // normally mirrors it. When it doesn't (note rewritten externally — AI
  // actions, "notes-updated" reload), push the new content into the view.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (body !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: body } });
    }
  }, [body]);

  // Highlight + scroll to the first occurrence of `highlightQuote` (case-
  // insensitive fallback, same as `replaceOnce`) — `null`/not found clears it.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc.toString();
    const quote = highlightQuote?.trim();
    let from = -1;
    if (quote) {
      from = doc.indexOf(quote);
      if (from < 0) from = doc.toLowerCase().indexOf(quote.toLowerCase());
    }
    if (from < 0) {
      view.dispatch({ effects: setHighlightEffect.of(null) });
      return;
    }
    const to = from + quote!.length;
    view.dispatch({
      effects: [setHighlightEffect.of({ from, to }), EditorView.scrollIntoView(from, { y: "center" })],
    });
  }, [highlightQuote, noteKey]);

  return <div ref={containerRef} style={{ flex: 1, overflow: "hidden", height: "100%" }} />;
});

export default NoteEditor;
