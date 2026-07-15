import { useEffect, useState, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";
import { MdFolder, MdStickyNote2, MdFactCheck } from "react-icons/md";
import { useNotesStore, findNodeByRef } from "../store/notesStore";
import { useResolveStore } from "../store/resolveStore";
import ShareButton from "../components/ShareButton";
import type { NoteMetadata } from "../bindings/NoteMetadata";
import type { Clarifications } from "../bindings/Clarifications";
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

  const navigate = useNavigate();
  const setResolveSession = useResolveStore((s) => s.setSession);
  const [analyzing, setAnalyzing] = useState(false);

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

  // Re-open the correction screen for a recording note (spec/17 §3): re-run the
  // analysis on its transcription and hydrate the /resolve session. Lets the user
  // review after quitting/relaunching (the live session isn't persisted). Costs
  // one Claude analysis call.
  const handleReview = async () => {
    const recordingId = localMetadata?.recording_id;
    if (!recordingId || analyzing) return;
    setAnalyzing(true);
    try {
      const clarifications = await invoke<Clarifications>("analyze_transcription", { recordingId });
      const tr = await invoke<{ raw_text?: string } | null>("get_transcription", { recordingId });
      setResolveSession({
        mode: "meeting",
        recordingId,
        noteTitle: localMetadata?.title ?? "",
        text: tr?.raw_text ?? localBody,
        clarifications,
        summary: true,
        tasks: true,
      });
      navigate("/resolve");
    } catch (e) {
      console.error("[notes] analyze_transcription failed:", e);
      window.alert(`Analyse impossible : ${e}`);
    } finally {
      setAnalyzing(false);
    }
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
            {/* Note actions: share (any note) + re-open correction (recordings). */}
            <div style={{ padding: "6px 16px", display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", borderBottom: "1px solid var(--border)" }}>
              {localMetadata.recording_id && (
                <button
                  onClick={handleReview}
                  disabled={analyzing}
                  title="Relancer l'analyse et rouvrir l'écran de correction"
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    background: "transparent", color: "var(--accent)",
                    border: "1px solid var(--border)", borderRadius: 8,
                    padding: "5px 12px", cursor: analyzing ? "default" : "pointer",
                    fontSize: 12.5, opacity: analyzing ? 0.6 : 1,
                  }}
                >
                  <MdFactCheck size={15} /> {analyzing ? "Analyse…" : "Vérifier / corriger"}
                </button>
              )}
              <ShareButton
                resetKey={selectedFile.path}
                getLink={() => invoke<string | null>("get_share_link", { notePath: selectedFile.path })}
                share={() => invoke<string>("share_note", { notePath: selectedFile.path })}
                unshare={() => invoke<void>("unshare_note", { notePath: selectedFile.path })}
              />
            </div>
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
