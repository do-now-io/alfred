import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MdCheckBox, MdFolderOff, MdUnfoldLess, MdUnfoldMore, MdEdit, MdVisibility } from "react-icons/md";
import NotePreview, { type NotePreviewHandle } from "../components/notes/NotePreview";
import NoteEditor from "../components/notes/NoteEditor";
import { useNotesStore } from "../store/notesStore";
import { toggleChecked, toggleImportant } from "../utils/todoTasks";

const btnStyle = (active: boolean): React.CSSProperties => ({
  background: active ? "var(--active-bg)" : "none",
  border: "1px solid var(--border)", borderRadius: 5,
  padding: "3px 8px", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap",
  color: active ? "var(--accent)" : "var(--text-secondary)",
  // Tailwind's preflight sets `svg { display: block }`, which would stack the
  // icon above the label — inline-flex keeps icon + text on one row.
  display: "inline-flex", alignItems: "center",
});
import type { NoteFile } from "../bindings/NoteFile";
import type { NoteMetadata } from "../bindings/NoteMetadata";

// The shared task list lives in the vault; its relative path is configurable in
// Settings (config key `todo_file_path`), defaulting to wiki/Todo.md.
const DEFAULT_TODO_RELATIVE = "wiki/Todo.md";

export default function Tasks() {
  const { vaultPath, fetchVaultPath, fetchRecents, openNoteByRef } = useNotesStore();
  const navigate = useNavigate();

  const [todoRel, setTodoRel] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const metadataRef = useRef<NoteMetadata | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const previewRef = useRef<NotePreviewHandle>(null);

  const relLabel = todoRel ?? DEFAULT_TODO_RELATIVE;
  const path = vaultPath && todoRel ? `${vaultPath}/${todoRel}` : null;

  const load = useCallback(async () => {
    if (!path) return;
    try {
      const file = await invoke<NoteFile>("get_note_file", { path });
      metadataRef.current = file.metadata;
      setBody(file.body);
      setMissing(false);
      setAllCollapsed(false);
    } catch (e) {
      console.error(`Tasks: cannot read ${path}:`, e);
      setMissing(true);
    } finally {
      setLoaded(true);
    }
  }, [path]);

  useEffect(() => { fetchVaultPath(); }, [fetchVaultPath]);

  // Which file holds the to-do list (configurable in Settings).
  useEffect(() => {
    invoke<string>("get_todo_file")
      .then(rel => setTodoRel(rel || DEFAULT_TODO_RELATIVE))
      .catch(() => setTodoRel(DEFAULT_TODO_RELATIVE));
  }, []);

  useEffect(() => {
    load();
    let unsub: (() => void) | undefined;
    listen("notes-updated", () => load()).then(fn => { unsub = fn; });
    return () => unsub?.();
  }, [load]);

  // Persist a checkbox toggle back to the file (debounced), then refresh recents.
  const save = useCallback((newBody: string) => {
    if (!path || !metadataRef.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      invoke<NoteFile>("update_note_file", { path, metadata: metadataRef.current, body: newBody })
        .then(() => fetchRecents())
        .catch(e => console.error("Tasks: save failed:", e));
    }, 800);
  }, [path, fetchRecents]);

  const handleToggleCheckbox = useCallback((idx: number) => {
    const updated = toggleChecked(body, idx);
    setBody(updated);
    save(updated);
  }, [body, save]);

  const handleToggleImportant = useCallback((idx: number) => {
    const updated = toggleImportant(body, idx);
    setBody(updated);
    save(updated);
  }, [body, save]);

  // Open wikilinks in the Notes screen.
  const handleWikilink = useCallback(async (ref: string) => {
    const ok = await openNoteByRef(ref);
    if (ok) navigate("/notes");
  }, [openNoteByRef, navigate]);

  const handleToggleCollapseAll = useCallback(() => {
    setAllCollapsed(previewRef.current?.toggleAll() ?? false);
  }, []);

  const handleBodyChange = useCallback((newBody: string) => {
    setBody(newBody);
    save(newBody);
  }, [save]);

  const showContent = loaded && vaultPath && !missing;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--card-bg)" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "16px 32px", borderBottom: "1px solid var(--border)", flexShrink: 0,
      }}>
        <MdCheckBox style={{ color: "var(--accent)", fontSize: 18 }} />
        <h1 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--text-primary)" }}>Tâches</h1>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {showContent && !editMode && (
            <button
              onClick={handleToggleCollapseAll}
              title={allCollapsed ? "Tout déplier" : "Tout replier"}
              style={btnStyle(allCollapsed)}
            >
              {allCollapsed
                ? <MdUnfoldMore style={{ verticalAlign: "middle", marginRight: 4 }} />
                : <MdUnfoldLess style={{ verticalAlign: "middle", marginRight: 4 }} />}
              {allCollapsed ? "Tout déplier" : "Tout replier"}
            </button>
          )}
          {showContent && (
            <button
              onClick={() => setEditMode(m => !m)}
              title={editMode ? "Mode lecture" : "Mode édition"}
              style={btnStyle(editMode)}
            >
              {editMode
                ? <MdVisibility style={{ verticalAlign: "middle", marginRight: 4 }} />
                : <MdEdit style={{ verticalAlign: "middle", marginRight: 4 }} />}
              {editMode ? "Lecture" : "Éditer"}
            </button>
          )}
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{relLabel}</span>
        </div>
      </div>

      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {!loaded ? null : !vaultPath || missing ? (
          <div style={{
            height: "100%", display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-muted)",
          }}>
            <MdFolderOff size={28} />
            <div style={{ fontSize: 14 }}>
              {!vaultPath ? "Aucun dossier Notes configuré" : `Aucun fichier ${relLabel} dans le vault`}
            </div>
          </div>
        ) : editMode ? (
          <NoteEditor
            body={body}
            noteKey={path ?? "todo"}
            onChange={handleBodyChange}
          />
        ) : (
          <NotePreview
            ref={previewRef}
            body={body}
            onWikilink={handleWikilink}
            onToggleCheckbox={handleToggleCheckbox}
            onToggleImportant={handleToggleImportant}
          />
        )}
      </div>
    </div>
  );
}
