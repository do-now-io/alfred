import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, placeholder } from "@codemirror/view";
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
  /** Live transcription (spec/16): appends a chunk ("\n\n" + text) with a short flash. */
  appendLiveText: (text: string) => void;
  /**
   * Live improvement (spec/16): replaces `original` with `improved` if the
   * exact original text is still in the doc. Returns false when it isn't
   * (the user edited that passage — their edit wins).
   */
  applyImprovement: (original: string, improved: string) => boolean;
}

// ─── Éphemeral highlight for freshly inserted/improved live text (spec/16) ─────

const addLiveFlash = StateEffect.define<{ from: number; to: number }>();
const clearLiveFlash = StateEffect.define<null>();
const liveFlashMark = Decoration.mark({ class: "cm-live-flash" });

const liveFlashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addLiveFlash) && e.value.to > e.value.from) {
        deco = deco.update({ add: [liveFlashMark.range(e.value.from, e.value.to)] });
      }
      if (e.is(clearLiveFlash)) deco = Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function flashRange(view: EditorView, from: number, to: number) {
  view.dispatch({ effects: addLiveFlash.of({ from, to }) });
  setTimeout(() => {
    try {
      view.dispatch({ effects: clearLiveFlash.of(null) });
    } catch {
      // view destroyed in the meantime — nothing to clear
    }
  }, 2000);
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
    appendLiveText(text: string) {
      const view = viewRef.current;
      if (!view) return;
      // Mirror of the backend actor's append: "\n\n" + chunk. Inserting at the
      // end never disturbs the user's cursor/selection.
      const from = view.state.doc.length;
      const insert = "\n\n" + text;
      view.dispatch({ changes: { from, insert } });
      flashRange(view, from + 2, from + insert.length);
    },
    applyImprovement(original: string, improved: string) {
      const view = viewRef.current;
      if (!view) return false;
      const doc = view.state.doc.toString();
      const from = doc.indexOf(original);
      if (from < 0) return false; // the user reworked this passage — keep it
      view.dispatch({ changes: { from, to: from + original.length, insert: improved } });
      flashRange(view, from, from + improved.length);
      return true;
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
        liveFlashField,
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
          ".cm-live-flash": {
            backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)",
            borderRadius: "3px",
            transition: "background-color 0.4s ease",
          },
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
