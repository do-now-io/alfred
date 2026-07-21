import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MdMoveToInbox, MdAutorenew, MdCheck, MdErrorOutline, MdStickyNote2, MdFolderSpecial, MdCreateNewFolder } from "react-icons/md";
import type { VaultNode } from "../../bindings/VaultNode";
import type { ProjectNote } from "../../bindings/ProjectNote";
import type { NoteFile } from "../../bindings/NoteFile";
import { useNotesStore } from "../../store/notesStore";
import { NoteTypeIcon, noteKind } from "../../utils/noteType";
import FileTreeNode from "./FileTreeNode";
import { useT } from "../../i18n";

/** Une entrée de la vue Projets : la note « porteuse » + éventuellement sa
 *  transcription appariée par `recording_id` (spec/07 — la paire reste ensemble,
 *  la transcription n'échoue plus dans « Sans projet »). */
interface ProjectEntry {
  note: ProjectNote;
  pair?: ProjectNote;
}

type IngestState = "idle" | "running" | "done" | "error";

interface Props {
  tree: VaultNode | null;
  vaultPath: string | null;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

export default function FileTree({ tree, vaultPath, selectedPath, onSelect }: Props) {
  const t = useT();
  const { createNote, deleteNote, renameNote, moveNote, createFolder, renameFolder, deleteFolder, fetchTree } = useNotesStore();
  const [renaming, setRenaming] = useState<{ path: string; current: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [folderDialog, setFolderDialog] = useState<
    { mode: "create"; parent: string } | { mode: "rename"; path: string } | null
  >(null);
  const [folderName, setFolderName] = useState("");
  const [ingest, setIngest] = useState<IngestState>("idle");
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [view, setView] = useState<"folders" | "projects">("folders");
  const [projectNotes, setProjectNotes] = useState<ProjectNote[]>([]);
  const [rootDragOver, setRootDragOver] = useState(false);
  // Vue Projets (feedback tests) : la transcription appariée est repliée par
  // défaut sous une seule ligne — un chevron la déplie (au lieu d'être toujours
  // affichée en retrait sous son compte-rendu).
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());
  const toggleEntryExpanded = (path: string) => {
    setExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // Project view (spec/07): virtual grouping by frontmatter `project`, no file
  // moved. Reload when switching to it or when the vault changes (`tree` advances
  // on every notes-updated, so this also refreshes after an ingestion).
  useEffect(() => {
    if (view !== "projects" || !vaultPath) return;
    let cancelled = false;
    invoke<ProjectNote[]>("get_notes_by_project")
      .then((n) => { if (!cancelled) setProjectNotes(n); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [view, vaultPath, tree]);

  // Group notes by project — `project` est une LISTE (spec/07) : une note
  // apparaît sous CHACUN de ses projets ; sans projet → « Sans projet » (dernier).
  // La PAIRE transcription+compte-rendu (même `recording_id`) reste ensemble :
  // la transcription (alfred-raw, sans projet propre) est rattachée au
  // compte-rendu qui porte le projet, au lieu de tomber dans « Sans projet ».
  const projectGroups = useMemo(() => {
    // « audio » = transcription datée d'un enregistrement, « transcription » =
    // note brute sans audio — les deux vivent dans alfred-raw et s'apparient pareil.
    const isTranscription = (n: ProjectNote) => {
      const k = noteKind({ path: n.path, noteType: n.type, recordingId: n.recording_id });
      return k === "audio" || k === "transcription";
    };

    // recording_id → transcription brute, pour l'appariement.
    const transcriptions = new Map<string, ProjectNote>();
    for (const n of projectNotes) {
      if (n.recording_id && isTranscription(n)) transcriptions.set(n.recording_id, n);
    }
    const paired = new Set<string>(); // paths des transcriptions rattachées

    const entries: ProjectEntry[] = [];
    for (const n of projectNotes) {
      if (isTranscription(n)) continue; // traitée via sa paire (ou en reliquat plus bas)
      const pair = n.recording_id ? transcriptions.get(n.recording_id) : undefined;
      if (pair) paired.add(pair.path);
      entries.push({ note: n, pair });
    }
    // Transcriptions orphelines (pas encore de compte-rendu) → entrées propres.
    for (const n of projectNotes) {
      if (isTranscription(n) && !paired.has(n.path)) entries.push({ note: n });
    }

    const map = new Map<string, ProjectEntry[]>();
    for (const e of entries) {
      const keys = e.note.project.map((p) => p.trim()).filter(Boolean);
      for (const key of keys.length ? keys : [""]) {
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(e);
      }
    }
    return [...map.entries()]
      .map(([project, list]) => ({
        project,
        entries: list.sort((a, b) => a.note.title.localeCompare(b.note.title)),
      }))
      .sort((a, b) => {
        if (a.project === "") return 1; // "Sans projet" last
        if (b.project === "") return -1;
        return a.project.localeCompare(b.project);
      });
  }, [projectNotes]);

  // Glisser-déposer une note sur un groupe (spec/07) : ajoute le projet cible à
  // la liste `project` du frontmatter (déposer sur « Sans projet » vide la liste).
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const handleDropOnProject = async (path: string, targetProject: string) => {
    setDropTarget(null);
    try {
      const note = await invoke<NoteFile>("get_note_file", { path });
      const current = note.metadata.project.map((p) => p.trim()).filter(Boolean);
      const next = targetProject === ""
        ? []
        : current.some((p) => p.toLowerCase() === targetProject.toLowerCase())
          ? current
          : [...current, targetProject];
      if (next.join(" ") === current.join(" ")) return;
      await invoke("update_note_file", {
        path,
        metadata: { ...note.metadata, project: next },
        body: note.body,
      });
      // Regroupe immédiatement (l'effet ci-dessus recharge sur `tree`, mais un
      // drop ne touche pas l'arbre physique — on recharge explicitement).
      const refreshed = await invoke<ProjectNote[]>("get_notes_by_project");
      setProjectNotes(refreshed);
    } catch (e) {
      console.error("[notes] drop project failed:", e);
    }
  };

  const handleCreate = async () => {
    if (!vaultPath) return;
    // New notes land in the vault's raw/ folder (the ingest source).
    await createNote(`${vaultPath}/raw`, t("notes.fileTree.newNoteDefaultTitle"));
  };

  // Re-runs the merged ingestion (spec/05) on the selected alfred-raw/ note —
  // regenerates its compte-rendu + re-extracts tasks. Ingestion also runs
  // automatically right after every recording; this is the manual "ré-ingérer".
  const handleIngest = async () => {
    if (ingest === "running" || !selectedPath) return;
    setIngest("running");
    setIngestError(null);

    try {
      await invoke("run_ingest", { notePath: selectedPath });
      await fetchTree(); // surface the freshly written compte-rendu
      setIngest("done");
      setTimeout(() => setIngest("idle"), 2500);
    } catch (e) {
      const msg = String(e);
      console.error("Ingest failed:", msg);
      setIngestError(msg);
      setIngest("error");
      setTimeout(() => setIngest("idle"), 5000);
    }
  };

  const handleDelete = async (path: string, name: string) => {
    if (window.confirm(t("notes.fileTree.confirmDeleteNote", { name }))) {
      await deleteNote(path);
    }
  };

  const handleRename = (path: string, current: string) => {
    setRenaming({ path, current });
    setNewName(current);
  };

  const handleRenameSubmit = async () => {
    if (!renaming || !newName.trim()) return;
    await renameNote(renaming.path, newName.trim());
    setRenaming(null);
  };

  const handleCreateFolder = (parentPath: string) => {
    setFolderDialog({ mode: "create", parent: parentPath });
    setFolderName(t("notes.fileTree.newFolderDefaultName"));
  };

  const handleRenameFolder = (path: string, current: string) => {
    setFolderDialog({ mode: "rename", path });
    setFolderName(current);
  };

  const handleDeleteFolder = async (path: string, name: string) => {
    if (window.confirm(t("notes.fileTree.confirmDeleteFolder", { name }))) {
      await deleteFolder(path);
    }
  };

  const handleFolderDialogSubmit = async () => {
    if (!folderDialog || !folderName.trim()) return;
    if (folderDialog.mode === "create") {
      await createFolder(folderDialog.parent, folderName.trim());
    } else {
      await renameFolder(folderDialog.path, folderName.trim());
    }
    setFolderDialog(null);
  };

  return (
    <div style={{
      width: 240, minWidth: 240,
      borderRight: "1px solid var(--border)",
      display: "flex", flexDirection: "column",
      overflow: "hidden", background: "var(--sidebar-bg)",
    }}>
      {/* Header */}
      <div style={{
        padding: "12px 12px 8px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        borderBottom: "1px solid var(--border)",
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {t("notes.fileTree.title")}
        </span>
        {vaultPath && (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <IngestButton state={ingest} error={ingestError} disabled={!selectedPath} onClick={handleIngest} t={t} />
            <button
              onClick={() => handleCreateFolder(vaultPath)}
              title={t("notes.fileTree.newFolder")}
              style={{
                background: "none", border: "none", cursor: "pointer",
                color: "var(--text-secondary)", fontSize: 16, lineHeight: 1, padding: 2,
                display: "inline-flex", alignItems: "center",
              }}
            >
              <MdCreateNewFolder size={16} />
            </button>
            <button
              onClick={handleCreate}
              title={t("notes.fileTree.newNote")}
              style={{
                background: "none", border: "none", cursor: "pointer",
                color: "var(--accent)", fontSize: 18, lineHeight: 1, padding: 2,
                display: "inline-flex", alignItems: "center",
              }}
            >
              +
            </button>
          </div>
        )}
      </div>

      {/* View toggle: physical folders vs virtual grouping by project (spec/07). */}
      {vaultPath && (
        <div style={{ display: "flex", gap: 4, padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
          {([["folders", t("notes.fileTree.viewFolders"), <MdStickyNote2 key="f" />], ["projects", t("notes.fileTree.viewProjects"), <MdFolderSpecial key="p" />]] as const).map(([id, label, icon]) => (
            <button
              key={id}
              onClick={() => setView(id)}
              style={{
                flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5,
                background: view === id ? "var(--active-bg)" : "transparent",
                color: view === id ? "var(--accent)" : "var(--text-secondary)",
                border: "1px solid var(--border)", borderRadius: 6,
                padding: "4px 0", cursor: "pointer", fontSize: 12,
              }}
            >
              {icon} {label}
            </button>
          ))}
        </div>
      )}

      {/* Tree */}
      <div
        style={{
          flex: 1, overflowY: "auto", padding: "4px 4px",
          background: rootDragOver ? "var(--active-bg)" : undefined,
        }}
        onDragOver={(e) => {
          // Dépose sur du vide (pas sur un dossier précis) → remonte à la racine
          // du vault (spec/07).
          if (vaultPath && view === "folders" && e.dataTransfer.types.includes("text/alfred-note-path")) {
            e.preventDefault();
            setRootDragOver(true);
          }
        }}
        onDragLeave={() => setRootDragOver(false)}
        onDrop={(e) => {
          if (!vaultPath || view !== "folders") return;
          e.preventDefault();
          setRootDragOver(false);
          const path = e.dataTransfer.getData("text/alfred-note-path");
          if (path) moveNote(path, vaultPath);
        }}
      >
        {!vaultPath && (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)", textAlign: "center", lineHeight: 1.6 }}>
            {t("notes.fileTree.noVaultConfigured")}<br />
            <span style={{ color: "var(--text-secondary)" }}>{t("notes.fileTree.noVaultHint")}</span>
          </div>
        )}

        {vaultPath && view === "folders" && tree && tree.children.map(node => (
          <FileTreeNode
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            onSelect={onSelect}
            onDelete={handleDelete}
            onRename={handleRename}
            onMove={moveNote}
            onCreateFolder={handleCreateFolder}
            onDeleteFolder={handleDeleteFolder}
            onRenameFolder={handleRenameFolder}
          />
        ))}

        {vaultPath && view === "projects" && (
          projectGroups.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)", textAlign: "center", lineHeight: 1.6 }}>
              {t("notes.fileTree.noNotes")}
            </div>
          ) : projectGroups.map(({ project, entries }) => (
            <div
              key={project || "__none__"}
              style={{ marginBottom: 6 }}
              onDragOver={(e) => { e.preventDefault(); setDropTarget(project); }}
              onDragLeave={() => setDropTarget((t) => (t === project ? null : t))}
              onDrop={(e) => {
                e.preventDefault();
                const path = e.dataTransfer.getData("text/alfred-note-path");
                if (path) handleDropOnProject(path, project);
              }}
            >
              <div style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "5px 8px", fontSize: 11, fontWeight: 700,
                color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em",
                borderRadius: 6,
                background: dropTarget === project ? "var(--active-bg)" : "transparent",
                outline: dropTarget === project ? "1px dashed var(--accent)" : "none",
              }}>
                <MdFolderSpecial size={13} style={{ color: project ? "var(--accent)" : "var(--text-muted)" }} />
                {project || t("notes.fileTree.noProject")}
                <span style={{ marginLeft: "auto", opacity: 0.7 }}>{entries.length}</span>
              </div>
              {entries.map(({ note: n, pair }) => {
                const isExpanded = expandedEntries.has(n.path);
                return (
                  <div key={n.path}>
                    <ProjectNoteRow
                      note={n}
                      active={n.path === selectedPath}
                      onSelect={onSelect}
                      expandable={!!pair}
                      expanded={isExpanded}
                      onToggleExpand={() => toggleEntryExpanded(n.path)}
                      t={t}
                    />
                    {/* Transcription appariée (même recording_id) — repliée par
                        défaut, dépliée via le chevron (spec/07, feedback tests). */}
                    {pair && isExpanded && (
                      <ProjectNoteRow note={pair} active={pair.path === selectedPath} onSelect={onSelect} indent t={t} />
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      {/* Rename dialog */}
      {renaming && (
        <div style={{
          padding: 12, borderTop: "1px solid var(--border)",
          background: "var(--card-bg)",
        }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>{t("notes.fileTree.renameLabel")}</div>
          <input
            autoFocus
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") handleRenameSubmit();
              if (e.key === "Escape") setRenaming(null);
            }}
            style={{
              width: "100%", border: "1px solid var(--border)", borderRadius: 6,
              padding: "5px 8px", fontSize: 13,
              background: "var(--bg)", color: "var(--text-primary)",
              marginBottom: 6,
            }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={handleRenameSubmit} style={btnStyle("#C8914A", "#fff")}>{t("notes.fileTree.ok")}</button>
            <button onClick={() => setRenaming(null)} style={btnStyle("transparent", "var(--text-secondary)", true)}>{t("notes.fileTree.cancel")}</button>
          </div>
        </div>
      )}

      {/* Dossier — création / renommage (spec/07) */}
      {folderDialog && (
        <div style={{
          padding: 12, borderTop: "1px solid var(--border)",
          background: "var(--card-bg)",
        }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
            {folderDialog.mode === "create" ? t("notes.fileTree.newFolderDialogTitle") : t("notes.fileTree.renameFolderDialogTitle")}
          </div>
          <input
            autoFocus
            value={folderName}
            onChange={e => setFolderName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") handleFolderDialogSubmit();
              if (e.key === "Escape") setFolderDialog(null);
            }}
            style={{
              width: "100%", border: "1px solid var(--border)", borderRadius: 6,
              padding: "5px 8px", fontSize: 13,
              background: "var(--bg)", color: "var(--text-primary)",
              marginBottom: 6,
            }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={handleFolderDialogSubmit} style={btnStyle("#C8914A", "#fff")}>{t("notes.fileTree.ok")}</button>
            <button onClick={() => setFolderDialog(null)} style={btnStyle("transparent", "var(--text-secondary)", true)}>{t("notes.fileTree.cancel")}</button>
          </div>
        </div>
      )}

    </div>
  );
}

/** Ligne de note de la vue Projets — draggable vers un groupe de projet.
 *  `expandable` (spec/07, feedback tests) : un chevron déplie/replie la
 *  transcription appariée au lieu de toujours l'afficher en retrait. */
function ProjectNoteRow({
  note, active, onSelect, indent, expandable, expanded, onToggleExpand, t,
}: {
  note: ProjectNote;
  active: boolean;
  onSelect: (path: string) => void;
  indent?: boolean;
  expandable?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div
      onClick={() => onSelect(note.path)}
      title={note.title}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/alfred-note-path", note.path);
        e.dataTransfer.effectAllowed = "link";
      }}
      style={{
        display: "flex", alignItems: "center", gap: 7,
        padding: `4px 8px 4px ${indent ? 36 : expandable ? 6 : 22}px`, cursor: "pointer", fontSize: 13,
        borderRadius: 6, color: active ? "var(--accent)" : "var(--text-secondary)",
        background: active ? "var(--active-bg)" : "transparent",
        overflow: "hidden", whiteSpace: "nowrap",
      }}
    >
      {expandable ? (
        <span
          onClick={(e) => { e.stopPropagation(); onToggleExpand?.(); }}
          title={expanded ? t("notes.fileTree.hideLinkedRecording") : t("notes.fileTree.showLinkedRecording")}
          style={{ fontSize: 10, width: 16, flexShrink: 0, color: "var(--text-muted)", textAlign: "center" }}
        >
          {expanded ? "▼" : "▶"}
        </span>
      ) : !indent ? (
        <span style={{ width: 16, flexShrink: 0 }} />
      ) : null}
      <NoteTypeIcon path={note.path} noteType={note.type} recordingId={note.recording_id} size={13} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{note.title}</span>
    </div>
  );
}

function btnStyle(bg: string, color: string, border = false): React.CSSProperties {
  return {
    flex: 1, background: bg, color,
    border: border ? "1px solid var(--border)" : "none",
    borderRadius: 6, padding: "5px 0", cursor: "pointer", fontSize: 12,
  };
}

function IngestButton({
  state,
  error,
  disabled,
  onClick,
  t,
}: {
  state: IngestState;
  error: string | null;
  disabled: boolean;
  onClick: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const running = state === "running";

  const { icon, color, title } = (() => {
    switch (state) {
      case "running":
        return {
          icon: <MdAutorenew style={{ display: "block", transformOrigin: "center", animation: "alfred-spin 0.8s linear infinite" }} />,
          color: "var(--accent)",
          title: t("notes.fileTree.ingest.running"),
        };
      case "done":
        return {
          icon: <MdCheck style={{ animation: "alfred-pop 0.3s ease" }} />,
          color: "#34C759",
          title: t("notes.fileTree.ingest.done"),
        };
      case "error":
        return {
          icon: <MdErrorOutline style={{ animation: "alfred-pop 0.3s ease" }} />,
          color: "var(--danger)",
          title: error ? t("notes.fileTree.ingest.error", { error }) : t("notes.fileTree.ingest.errorGeneric"),
        };
      default:
        return {
          icon: <MdMoveToInbox />,
          color: disabled ? "var(--text-muted)" : "var(--text-secondary)",
          title: disabled ? t("notes.fileTree.ingest.disabled") : t("notes.fileTree.ingest.idle"),
        };
    }
  })();

  return (
    <button
      onClick={onClick}
      disabled={running || disabled}
      title={title}
      style={{
        background: "none", border: "none",
        cursor: disabled ? "not-allowed" : running ? "wait" : "pointer",
        color, fontSize: 17, lineHeight: 1, padding: 2,
        display: "inline-flex", alignItems: "center",
        transition: "color 0.15s",
      }}
    >
      {icon}
    </button>
  );
}
