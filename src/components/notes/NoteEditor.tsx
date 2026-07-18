import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import { markdownLivePreview, toggleAllHeadingFolds } from "./markdownLivePreview";

// French labels for the CodeMirror search panel (spec/07 — recherche in-file).
const frenchPhrases = EditorState.phrases.of({
  "Find": "Rechercher",
  "Replace": "Remplacer",
  "next": "suivant",
  "previous": "précédent",
  "all": "tout",
  "match case": "casse",
  "by word": "mots entiers",
  "regexp": "regex",
  "replace": "remplacer",
  "replace all": "tout remplacer",
  "close": "fermer",
  "current match": "correspondance courante",
  "replaced $ matches": "$ correspondances remplacées",
  "replaced match on line $": "correspondance remplacée ligne $",
  "on line": "à la ligne",
  "Go to line": "Aller à la ligne",
  "go": "aller",
});

interface Props {
  body: string;
  noteKey: string; // used to reset editor when note changes
  onChange: (body: string) => void;
  onWikilink?: (ref: string) => void;
  /** When true, each task gets a ★ toggle to flag it important (Tâches screen). */
  importantToggles?: boolean;
}

// Imperative API for "fold/unfold every section at once" from a parent toolbar.
export interface NoteEditorHandle {
  /** Toggles all heading sections; returns true if they are now all folded. */
  toggleAll: () => boolean;
  /** Opens the in-file search panel (Ctrl/Cmd+F equivalent). */
  openSearch: () => void;
}

const NoteEditor = forwardRef<NoteEditorHandle, Props>(function NoteEditor(
  { body, noteKey, onChange, onWikilink, importantToggles }, ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onWikilinkRef = useRef(onWikilink);
  onWikilinkRef.current = onWikilink;

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
        markdownLivePreview({ onWikilink: r => onWikilinkRef.current?.(r), importantToggles }),
        placeholder("Commencez à écrire…"),
        search({ top: true }),
        highlightSelectionMatches(),
        frenchPhrases,
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
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    view.focus();

    return () => { view.destroy(); viewRef.current = null; };
  }, [noteKey]); // remount when note changes

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

  return <div ref={containerRef} style={{ flex: 1, overflow: "hidden", height: "100%" }} />;
});

export default NoteEditor;
