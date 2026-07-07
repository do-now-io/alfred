import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { markdownLivePreview, toggleAllHeadingFolds } from "./markdownLivePreview";

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
  }), []);

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: body,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        // GFM-enabled parsing (task lists, strikethrough, tables) for the live preview.
        markdown({ base: markdownLanguage }),
        markdownLivePreview({ onWikilink: r => onWikilinkRef.current?.(r), importantToggles }),
        placeholder("Commencez à écrire…"),
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
