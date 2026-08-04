import { useEffect, useState, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";
import { MdFolder, MdStickyNote2, MdFactCheck, MdSearch } from "react-icons/md";
import { useNotesStore, findNodeByRef } from "../store/notesStore";
import { useResolveStore } from "../store/resolveStore";
import { usePendingReviewStore } from "../store/pendingReviewStore";
import { useInternalLink } from "../utils/useInternalLink";
import ShareButton from "../components/ShareButton";
import type { NoteMetadata } from "../bindings/NoteMetadata";
import type { Clarifications } from "../bindings/Clarifications";
import FileTree from "../components/notes/FileTree";
import PropertiesPanel from "../components/notes/PropertiesPanel";
import NoteEditor, { type NoteEditorHandle } from "../components/notes/NoteEditor";
import NoteFooter from "../components/notes/NoteFooter";
import NoteBreadcrumb from "../components/notes/NoteBreadcrumb";
import { useT } from "../i18n";

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
  const t = useT();
  const {
    tree, selectedFile, vaultPath, history,
    fetchTree, selectFile, goBack, updateNote,
    fetchVaultPath, setVaultPath, pickVaultFolder,
  } = useNotesStore();

  const navigate = useNavigate();
  const handleLink = useInternalLink();
  const setResolveSession = useResolveStore((s) => s.setSession);
  const loadPersisted = useResolveStore((s) => s.loadPersisted);
  const pendingReviewIds = usePendingReviewStore((s) => s.ids);
  const [analyzing, setAnalyzing] = useState(false);

  const [localMetadata, setLocalMetadata] = useState<NoteMetadata | null>(null);
  const [localBody, setLocalBody] = useState("");
  const editorRef = useRef<NoteEditorHandle>(null);
  const [allCollapsed, setAllCollapsed] = useState(false);
  // Propriétés repliées sur un clic dans le texte (feedback tests — la
  // section prenait trop de place à la lecture) ; redéployée à l'ouverture
  // d'une nouvelle note (voir l'effet de sync ci-dessous) ou via son en-tête.
  const [propertiesCollapsed, setPropertiesCollapsed] = useState(false);

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
      setPropertiesCollapsed(false);
    }
  }, [selectedFile?.path]);

  const handleToggleCollapseAll = useCallback(() => {
    setAllCollapsed(editorRef.current?.toggleAll() ?? false);
  }, []);

  // Ctrl/Cmd+F → recherche dans la note ouverte (spec/07), même quand le focus
  // est hors de l'éditeur (arbre de fichiers, propriétés). No-op sans note.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        editorRef.current?.openSearch();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
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
    // Ne sauve que si le contenu diffère réellement de ce qui est chargé —
    // sans ce garde-fou, le simple fait d'ouvrir une note pouvait déclencher
    // une sauvegarde fantôme (la resynchro `body`/`noteKey` de NoteEditor au
    // changement de note se produit sur deux rendus, avec un "correctif" de
    // contenu qui remonte par `onChange` bien que rien n'ait été tapé) — sans
    // aucun changement visible, mais en écrivant quand même sur disque à
    // chaque ouverture, ce qui accumulait des sauts de ligne en tête de note
    // (bug de non-idempotence corrigé côté frontmatter.rs) et faussait aussi
    // le tri des Récents (censé n'avancer qu'à une vraie modification).
    if (selectedFile && localMetadata && body !== selectedFile.body) {
      debouncedSave(selectedFile.path, localMetadata, body);
    }
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
        projectsConfirmed: clarifications.projects_detected,
      });
      navigate("/resolve");
    } catch (e) {
      console.error("[notes] analyze_transcription failed:", e);
      window.alert(t("notes.analyzeError", { error: String(e) }));
    } finally {
      setAnalyzing(false);
    }
  };

  // Ouvre l'analyse déjà persistée (spec/17 §3/spec/07, feedback tests) — clic
  // sur l'indicateur « à vérifier » de l'arbre, sans relancer `analyze_transcription`.
  const handleOpenReview = useCallback(async (recordingId: string) => {
    if (await loadPersisted(recordingId)) navigate("/resolve");
  }, [loadPersisted, navigate]);

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
        pendingReviewIds={pendingReviewIds}
        onOpenReview={handleOpenReview}
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
              {t("notes.emptyVault.title")}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              {t("notes.emptyVault.text")}
            </div>
            <button
              onClick={handlePickVault}
              style={{
                background: "var(--accent)", color: "#fff", border: "none",
                borderRadius: 8, padding: "8px 20px", cursor: "pointer",
                fontSize: 14, fontWeight: 500,
              }}
            >
              {t("notes.emptyVault.chooseFolder")}
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
            <div style={{ fontSize: 14 }}>{t("notes.noNoteSelected")}</div>
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
            {/* Note actions: search + share (any note) + re-open correction (recordings). */}
            <div style={{ padding: "6px 16px", display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", borderBottom: "1px solid var(--border)" }}>
              <button
                onClick={() => editorRef.current?.openSearch()}
                title={t("notes.actions.search")}
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  background: "transparent", color: "var(--text-secondary)",
                  border: "1px solid var(--border)", borderRadius: 8,
                  padding: "5px 8px", cursor: "pointer",
                }}
              >
                <MdSearch size={15} />
              </button>
              {localMetadata.recording_id && (
                <button
                  onClick={handleReview}
                  disabled={analyzing}
                  title={t("notes.actions.reviewTitle")}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    background: "transparent", color: "var(--accent)",
                    border: "1px solid var(--border)", borderRadius: 8,
                    padding: "5px 12px", cursor: analyzing ? "default" : "pointer",
                    fontSize: 12.5, opacity: analyzing ? 0.6 : 1,
                  }}
                >
                  <MdFactCheck size={15} /> {analyzing ? t("notes.actions.analyzing") : t("notes.actions.review")}
                </button>
              )}
              <ShareButton
                resetKey={selectedFile.path}
                getLink={() => invoke<string | null>("get_share_link", { notePath: selectedFile.path })}
                share={() => invoke<string>("share_note", { notePath: selectedFile.path })}
                unshare={() => invoke<void>("unshare_note", { notePath: selectedFile.path })}
              />
            </div>
            <PropertiesPanel
              metadata={localMetadata}
              onChange={handleMetadataChange}
              collapsed={propertiesCollapsed}
              onToggleCollapsed={() => setPropertiesCollapsed((v) => !v)}
            />

            {/* Un clic dans le texte replie les propriétés (feedback tests) —
                capturé ici plutôt que dans NoteEditor pour ne pas coupler
                l'éditeur à ce comportement d'écran. */}
            <div
              style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}
              onMouseDown={() => { if (!propertiesCollapsed) setPropertiesCollapsed(true); }}
            >
              <NoteEditor
                ref={editorRef}
                body={localBody}
                noteKey={selectedFile.path}
                onChange={handleBodyChange}
                onWikilink={handleWikilink}
                onNavigate={handleLink}
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
