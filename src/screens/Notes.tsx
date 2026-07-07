import { useEffect, useState, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { MdFolder, MdStickyNote2 } from "react-icons/md";
import { useNotesStore, findNodeByRef } from "../store/notesStore";
import type { NoteMetadata } from "../bindings/NoteMetadata";
import FileTree from "../components/notes/FileTree";
import PropertiesPanel from "../components/notes/PropertiesPanel";
import NoteEditor, { type NoteEditorHandle } from "../components/notes/NoteEditor";
import NoteFooter from "../components/notes/NoteFooter";
import NoteBreadcrumb from "../components/notes/NoteBreadcrumb";

function useDebounce<T extends (...args: Parameters<T>) => void>(fn: T, ms: number): T {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(
    ((...args: Parameters<T>) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => fn(...args), ms);
    }) as T,
    [fn, ms]
  );
}

export default function Notes() {
  const {
    tree, selectedFile, vaultPath, history,
    fetchTree, selectFile, goBack, updateNote,
    fetchVaultPath, setVaultPath, pickVaultFolder,
  } = useNotesStore();

  const [localMetadata, setLocalMetadata] = useState<NoteMetadata | null>(null);
  const [localBody, setLocalBody] = useState("");
  const editorRef = useRef<NoteEditorHandle>(null);
  const [allCollapsed, setAllCollapsed] = useState(false);

  useEffect(() => {
    fetchVaultPath().then(() => {
      fetchTree();
    });

    let unsub: (() => void) | undefined;
    listen("notes-updated", () => fetchTree()).then(fn => { unsub = fn; });
    return () => unsub?.();
  }, [fetchVaultPath, fetchTree]);

  // Sync local state when selected file changes
  useEffect(() => {
    if (selectedFile) {
      setLocalMetadata(selectedFile.metadata);
      setLocalBody(selectedFile.body);
      setAllCollapsed(false);
    }
  }, [selectedFile?.path]);

  const handleToggleCollapseAll = useCallback(() => {
    setAllCollapsed(editorRef.current?.toggleAll() ?? false);
  }, []);

  const debouncedSave = useDebounce(
    useCallback((path: string, metadata: NoteMetadata, body: string) => {
      updateNote(path, metadata, body);
    }, [updateNote]),
    2000
  );

  const handleMetadataChange = (updated: NoteMetadata) => {
    setLocalMetadata(updated);
    if (selectedFile) debouncedSave(selectedFile.path, updated, localBody);
  };

  const handleBodyChange = (body: string) => {
    setLocalBody(body);
    if (selectedFile && localMetadata) debouncedSave(selectedFile.path, localMetadata, body);
  };

  const handlePickVault = async () => {
    const picked = await pickVaultFolder();
    if (picked) await setVaultPath(picked);
  };

  const handleWikilink = useCallback((ref: string) => {
    console.log(`[wikilink] Notes: handleWikilink ref="${ref}", tree ${tree ? "loaded" : "NOT loaded"}`);
    if (!tree) return;
    const path = findNodeByRef(tree, ref);
    console.log(`[wikilink] Notes: resolved path=${path ? `"${path}"` : "null (no file matches)"}`);
    if (path) {
      selectFile(path);
    } else {
      console.warn(`[wikilink] Notes: note not found: ${ref}`);
    }
  }, [tree, selectFile]);

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* File tree */}
      <FileTree
        tree={tree}
        vaultPath={vaultPath}
        selectedPath={selectedFile?.path ?? null}
        onSelect={selectFile}
      />

      {/* Content pane */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--card-bg)" }}>

        {/* No vault configured */}
        {!vaultPath && (
          <div style={{
            flex: 1, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", gap: 16,
          }}>
            <MdFolder size={36} color="var(--text-muted)" />
            <div style={{ fontSize: 16, fontWeight: 500, color: "var(--text-primary)" }}>
              Aucun dossier Notes configuré
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              Choisissez un dossier pour stocker vos notes en Markdown
            </div>
            <button
              onClick={handlePickVault}
              style={{
                background: "var(--accent)", color: "#fff", border: "none",
                borderRadius: 8, padding: "8px 20px", cursor: "pointer",
                fontSize: 14, fontWeight: 500,
              }}
            >
              Choisir un dossier…
            </button>
          </div>
        )}

        {/* Vault configured but no note selected */}
        {vaultPath && !selectedFile && (
          <div style={{
            flex: 1, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", gap: 8,
            color: "var(--text-muted)",
          }}>
            <MdStickyNote2 size={28} color="var(--text-muted)" />
            <div style={{ fontSize: 14 }}>Sélectionnez une note ou créez-en une avec +</div>
          </div>
        )}

        {/* Note open */}
        {vaultPath && selectedFile && localMetadata && (
          <>
            <NoteBreadcrumb
              filePath={selectedFile.path}
              vaultPath={vaultPath}
              history={history}
              onBack={goBack}
              onOpenHistoryEntry={selectFile}
            />
            <PropertiesPanel metadata={localMetadata} onChange={handleMetadataChange} />

            <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <NoteEditor
                ref={editorRef}
                body={localBody}
                noteKey={selectedFile.path}
                onChange={handleBodyChange}
                onWikilink={handleWikilink}
              />
            </div>

            <NoteFooter
              wordCount={selectedFile.word_count}
              charCount={selectedFile.char_count}
              propCount={selectedFile.prop_count}
              allCollapsed={allCollapsed}
              onToggleCollapseAll={handleToggleCollapseAll}
            />
          </>
        )}
      </div>
    </div>
  );
}
