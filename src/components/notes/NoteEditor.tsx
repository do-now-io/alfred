import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { markdownLivePreview } from "./markdownLivePreview";

interface Props {
  body: string;
  noteKey: string; // used to reset editor when note changes
  onChange: (body: string) => void;
}

export default function NoteEditor({ body, noteKey, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: body,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        // GFM-enabled parsing (task lists, strikethrough, tables) for the live preview.
        markdown({ base: markdownLanguage }),
        markdownLivePreview,
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

  return <div ref={containerRef} style={{ flex: 1, overflow: "hidden", height: "100%" }} />;
}
