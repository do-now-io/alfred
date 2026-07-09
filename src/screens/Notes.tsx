import { useEffect, useState, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { MdFolder, MdStickyNote2 } from "react-icons/md";
import { useNotesStore, findNodeByRef } from "../store/notesStore";
import { useLiveSessionStore } from "../store/liveSessionStore";
import type { NoteMetadata } from "../bindings/NoteMetadata";
import type { NoteFile } from "../bindings/NoteFile";
import type { LiveChunkEvent } from "../bindings/LiveChunkEvent";
import type { LiveSessionSnapshot } from "../bindings/LiveSessionSnapshot";
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

  // ── Session live (spec/16) : la note en cours d'enregistrement ──────────────
  const liveActive = useLiveSessionStore((s) => s.active);
  const liveNotePath = useLiveSessionStore((s) => s.notePath);
  const isLive = liveActive && !!selectedFile && selectedFile.path === liveNotePath;
  const isLiveRef = useRef(isLive);
  isLiveRef.current = isLive;
  // Dernier chunk réellement présent dans le doc de l'éditeur — la promesse
  // faite au backend via save_live_note (il ré-appende tout seq supérieur).
  const lastSeqRef = useRef(0);

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

  // Note live ouverte (spec/16) : initialise le doc depuis le snapshot de la
  // session (corps autoritaire + last_seq) puis applique les chunks en direct.
  // Les événements arrivés avant le snapshot sont bufferisés : le snapshot,
  // pris par l'acteur APRÈS eux, les contient déjà — on ne duplique jamais.
  useEffect(() => {
    if (!isLive || !selectedFile) return;
    const path = selectedFile.path;
    let disposed = false;
    let ready = false;
    let pending: LiveChunkEvent[] = [];
    let unsub: (() => void) | undefined;

    listen<LiveChunkEvent>("live-transcription-chunk", (e) => {
      if (disposed) return;
      if (!ready) {
        pending.push(e.payload);
        return;
      }
      if (e.payload.seq > lastSeqRef.current) {
        editorRef.current?.appendLiveText(e.payload.text);
        lastSeqRef.current = e.payload.seq;
      }
    }).then((fn) => {
      if (disposed) fn();
      else unsub = fn;
    });

    invoke<LiveSessionSnapshot | null>("get_live_session").then((snap) => {
      if (disposed) return;
      if (snap && snap.note_path === path) {
        let body = snap.body;
        let seq = snap.last_seq;
        for (const p of [...pending].sort((a, b) => a.seq - b.seq)) {
          if (p.seq > seq) {
            body += "\n\n" + p.text;
            seq = p.seq;
          }
        }
        lastSeqRef.current = seq;
        setLocalMetadata(snap.metadata);
        setLocalBody(body);
      }
      pending = [];
      ready = true;
    });

    return () => {
      disposed = true;
      unsub?.();
    };
  }, [isLive, selectedFile?.path]);

  const handleToggleCollapseAll = useCallback(() => {
    setAllCollapsed(editorRef.current?.toggleAll() ?? false);
  }, []);

  const debouncedSave = useDebounce(
    useCallback(async (path: string, metadata: NoteMetadata, body: string) => {
      // Note live : le save passe par l'acteur de la session, qui ré-appende
      // les chunks non encore vus (seq > lastSeq) — aucun texte perdu (spec/16).
      if (isLiveRef.current && path === useLiveSessionStore.getState().notePath) {
        try {
          const file = await invoke<NoteFile>("save_live_note", {
            path, metadata, body,
            lastSeq: lastSeqRef.current,
          });
          useNotesStore.setState({ selectedFile: file });
          return;
        } catch (e) {
          console.error("[live] save_live_note failed, falling back:", e);
        }
      }
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
              live={isLive}
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
