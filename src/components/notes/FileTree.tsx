import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MdMoveToInbox, MdAutorenew, MdCheck, MdErrorOutline, MdStickyNote2, MdFolderSpecial, MdCreateNewFolder, MdArchive, MdUnarchive, MdInfoOutline, MdCallMerge, MdEdit, MdDelete } from "react-icons/md";
import type { VaultNode } from "../../bindings/VaultNode";
import type { ProjectNote } from "../../bindings/ProjectNote";
import type { NoteFile } from "../../bindings/NoteFile";
import { useNotesStore } from "../../store/notesStore";
import { NoteTypeIcon, noteKind } from "../../utils/noteType";
import FileTreeNode from "./FileTreeNode";
import ProjectOverviewPanel from "./ProjectOverviewPanel";
import { menuItemStyle } from "./NoteContextMenu";
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
  /** Indicateur « à vérifier » persistant (spec/17 §3/spec/07, feedback tests). */
  pendingReviewIds?: Set<string>;
  onOpenReview?: (recordingId: string) => void;
}

export default function FileTree({ tree, vaultPath, selectedPath, onSelect, pendingReviewIds, onOpenReview }: Props) {
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
  // Masque les notes `status: archived` par défaut (spec/07 — archivage auto
  // des transcriptions après ingestion) ; le bouton « Afficher les archives »
  // les révèle (estompées, badge), sans jamais rien retirer du disque.
  const [showArchived, setShowArchived] = useState(false);
  const [projectNotes, setProjectNotes] = useState<ProjectNote[]>([]);
  const [rootDragOver, setRootDragOver] = useState(false);
  // Vue Projets (feedback tests) : la transcription appariée est repliée par
  // défaut sous une seule ligne — un chevron la déplie (au lieu d'être toujours
  // affichée en retrait sous son compte-rendu).
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());
  // Menu contextuel de l'en-tête de groupe (spec/28 « Voir l'état du projet »,
  // spec/07/16b « Fusionner avec… » — nettoyage manuel des quasi-doublons).
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number; project: string } | null>(null);
  const [viewingProject, setViewingProject] = useState<string | null>(null);
  const [mergingProject, setMergingProject] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState("");
  const [merging, setMerging] = useState(false);
  // Renommer un projet (spec/07) — même geste que la fusion (`merge_projects`
  // sert de renommage quand la cible n'existe pas encore comme groupe), mais
  // une entrée de menu et un dialogue DÉDIÉS : un simple champ texte préréempli
  // du nom actuel, pas un picker de projet existant.
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [renameProjectValue, setRenameProjectValue] = useState("");
  const [renamingProjectBusy, setRenamingProjectBusy] = useState(false);

  // Clic sur le nom du projet (spec/16b, spec/07) : ouvre (crée lazily au
  // besoin) SA note de contexte unique — « un seul fichier de contexte par
  // projet, accessible en cliquant sur son nom ».
  const openProjectContext = async (project: string) => {
    if (!project) return;
    try {
      const note = await invoke<NoteFile>("open_project_context_note", { project });
      await fetchTree(); // la note vient peut-être d'être créée
      onSelect(note.path);
    } catch (e) {
      console.error("[notes] open_project_context_note failed:", e);
    }
  };

  const handleMergeSubmit = async () => {
    if (!mergingProject || !mergeTarget.trim() || merging) return;
    setMerging(true);
    try {
      await invoke("merge_projects", { source: mergingProject, target: mergeTarget.trim() });
      setMergingProject(null);
      setMergeTarget("");
      await fetchTree();
      const refreshed = await invoke<ProjectNote[]>("get_notes_by_project");
      setProjectNotes(refreshed);
    } catch (e) {
      console.error("[notes] merge_projects failed:", e);
      window.alert(String(e));
    } finally {
      setMerging(false);
    }
  };

  const handleRenameProjectSubmit = async () => {
    const newName = renameProjectValue.trim();
    if (!renamingProject || !newName || newName === renamingProject || renamingProjectBusy) return;
    setRenamingProjectBusy(true);
    try {
      await invoke("merge_projects", { source: renamingProject, target: newName });
      setRenamingProject(null);
      setRenameProjectValue("");
      await fetchTree();
      const refreshed = await invoke<ProjectNote[]>("get_notes_by_project");
      setProjectNotes(refreshed);
    } catch (e) {
      console.error("[notes] rename project failed:", e);
      window.alert(String(e));
    } finally {
      setRenamingProjectBusy(false);
    }
  };

  const handleDeleteProject = async (project: string) => {
    if (!window.confirm(t("notes.fileTree.confirmDeleteProject", { project }))) return;
    try {
      await invoke("delete_project", { project });
      await fetchTree();
      const refreshed = await invoke<ProjectNote[]>("get_notes_by_project");
      setProjectNotes(refreshed);
    } catch (e) {
      console.error("[notes] delete_project failed:", e);
      window.alert(String(e));
    }
  };

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
    // Masquage des archivées (spec/07, feedback tests) — bug corrigé : ce
    // filtre n'était appliqué qu'à la vue Dossiers, jamais à Projects, qui
    // les montrait donc en permanence.
    // Note de contexte du projet (spec/16b) exclue de la liste : ce n'est pas
    // une note d'« activité » du projet, elle s'ouvre en cliquant le TITRE du
    // groupe (`openProjectContext`), pas comme une entrée de plus dans la liste.
    const visible = (showArchived ? projectNotes : projectNotes.filter((n) => n.status !== "archived"))
      .filter((n) => n.type !== "context");

    // « audio » = transcription datée d'un enregistrement, « transcription » =
    // note brute sans audio — les deux vivent dans alfred-raw et s'apparient pareil.
    const isTranscription = (n: ProjectNote) => {
      const k = noteKind({ path: n.path, noteType: n.type, recordingId: n.recording_id });
      return k === "audio" || k === "transcription";
    };

    // recording_id → transcription brute, pour l'appariement. Cherché dans
    // `visible` : une transcription archivée ne doit s'apparier que si le
    // toggle « Afficher les archives » est actif (sinon elle n'est même pas
    // dans `visible`, donc pas de paire — la note porteuse s'affiche seule).
    const transcriptions = new Map<string, ProjectNote>();
    for (const n of visible) {
      if (n.recording_id && isTranscription(n)) transcriptions.set(n.recording_id, n);
    }
    const paired = new Set<string>(); // paths des transcriptions rattachées

    const entries: ProjectEntry[] = [];
    for (const n of visible) {
      if (isTranscription(n)) continue; // traitée via sa paire (ou en reliquat plus bas)
      const pair = n.recording_id ? transcriptions.get(n.recording_id) : undefined;
      if (pair) paired.add(pair.path);
      entries.push({ note: n, pair });
    }
    // Transcriptions orphelines (pas encore de compte-rendu) → entrées propres.
    for (const n of visible) {
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
  }, [projectNotes, showArchived]);

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

  // Filtre récursif : retire les fichiers `status: archived` (les dossiers
  // restent, même vidés de tout leur contenu par le filtre) — n'a d'effet que
  // si `showArchived` est faux.
  const filterArchived = (node: VaultNode): VaultNode => {
    if (!node.is_dir) return node;
    return {
      ...node,
      children: node.children
        .filter((c) => showArchived || c.is_dir || c.status !== "archived")
        .map(filterArchived),
    };
  };

  const handleCreate = async () => {
    if (!vaultPath) return;
    // Dossier des nouvelles notes : config `new_note_folder` (spec/07/11),
    // défaut alfred-raw. Le dossier est créé au besoin côté Rust.
    const folder = (
      (await invoke<string | null>("get_config", { key: "new_note_folder" })) || "alfred-raw"
    ).replace(/^\/+|\/+$/g, "");
    await createNote(`${vaultPath}/${folder}`, t("notes.fileTree.newNoteDefaultTitle"));
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

      {/* View toggle: physical folders vs virtual grouping by project (spec/07).
          Seulement 2 cases (spec/07, feedback tests) — le toggle « archives »
          n'est PAS un 3e bouton ici, c'est un filtre, pas un choix de vue ; il
          vit en pied d'arbre (ci-dessous), identique dans les deux vues. */}
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

        {vaultPath && view === "folders" && tree && filterArchived(tree).children.map(node => (
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
            pendingReviewIds={pendingReviewIds}
            onOpenReview={onOpenReview}
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
              <div
                onClick={() => openProjectContext(project)}
                onContextMenu={(e) => {
                  if (!project) return; // « Sans projet » n'a pas d'état à afficher
                  e.preventDefault();
                  setProjectMenu({ x: e.clientX, y: e.clientY, project });
                }}
                title={project ? t("notes.fileTree.openProjectContext") : undefined}
                style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "5px 8px", fontSize: 11, fontWeight: 700,
                color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em",
                borderRadius: 6, cursor: project ? "pointer" : "default",
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

      {/* Pied d'arbre (spec/07, feedback tests) : le toggle « archives » est un
          FILTRE, pas un choix de vue — retiré du sélecteur Dossiers/Projets,
          identique dans les deux vues (le filtre s'applique à `filterArchived`
          ET `projectGroups` ci-dessus). */}
      {vaultPath && (
        <div style={{ padding: "6px 8px", borderTop: "1px solid var(--border)" }}>
          <button
            onClick={() => setShowArchived((v) => !v)}
            style={{
              display: "flex", alignItems: "center", gap: 6, width: "100%",
              background: showArchived ? "var(--active-bg)" : "transparent",
              color: showArchived ? "var(--accent)" : "var(--text-muted)",
              border: "1px solid var(--border)", borderRadius: 6,
              padding: "5px 8px", cursor: "pointer", fontSize: 12,
            }}
          >
            {showArchived ? <MdUnarchive size={14} /> : <MdArchive size={14} />}
            {showArchived ? t("notes.fileTree.hideArchived") : t("notes.fileTree.showArchived")}
          </button>
        </div>
      )}

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

      {/* Menu contextuel de l'en-tête de groupe (spec/28, entrée #2) */}
      {projectMenu && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 999 }} onClick={() => setProjectMenu(null)} />
          <div style={{
            position: "fixed", left: projectMenu.x, top: projectMenu.y,
            background: "var(--card-bg)", border: "1px solid var(--border)",
            borderRadius: 8, padding: 4, zIndex: 1000, minWidth: 180,
            boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
          }}>
            <button
              onClick={() => { setViewingProject(projectMenu.project); setProjectMenu(null); }}
              style={menuItemStyle}
            >
              <MdInfoOutline size={15} /> {t("notes.projectOverview.menuEntry")}
            </button>
            <button
              onClick={() => { setMergingProject(projectMenu.project); setMergeTarget(""); setProjectMenu(null); }}
              style={menuItemStyle}
            >
              <MdCallMerge size={15} /> {t("notes.fileTree.mergeMenuEntry")}
            </button>
            {/* Mêmes actions que le clic droit sur un dossier (vue Dossiers,
                `NoteContextMenu`) — renommer/supprimer, appliquées au projet. */}
            <button
              onClick={() => { setRenamingProject(projectMenu.project); setRenameProjectValue(projectMenu.project); setProjectMenu(null); }}
              style={menuItemStyle}
            >
              <MdEdit size={15} /> {t("notes.contextMenu.rename")}
            </button>
            <button
              onClick={() => { const p = projectMenu.project; setProjectMenu(null); handleDeleteProject(p); }}
              style={menuItemStyle}
            >
              <MdDelete size={15} /> {t("notes.contextMenu.delete")}
            </button>
          </div>
        </>
      )}

      {viewingProject && (
        <ProjectOverviewPanel project={viewingProject} onClose={() => setViewingProject(null)} />
      )}

      {/* Fusion de projets (spec/07/16b) — nettoyage manuel des quasi-doublons
          créés par une extraction (mail/réunion) qui a inventé un nom proche
          d'un projet déjà connu. Action explicite, jamais automatique. */}
      {mergingProject && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(0,0,0,0.3)" }} onClick={() => !merging && setMergingProject(null)} />
          <div style={{
            position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            background: "var(--card-bg)", border: "1px solid var(--border)",
            borderRadius: 10, padding: 16, zIndex: 1000, width: 340,
            boxShadow: "0 8px 28px rgba(0,0,0,0.25)",
          }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
              {t("notes.fileTree.mergeDialogTitle", { project: mergingProject })}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 10, lineHeight: 1.5 }}>
              {t("notes.fileTree.mergeDialogHint")}
            </div>
            <input
              autoFocus
              list="alfred-merge-project-options"
              value={mergeTarget}
              onChange={(e) => setMergeTarget(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleMergeSubmit(); if (e.key === "Escape") setMergingProject(null); }}
              placeholder={t("notes.fileTree.mergeDialogPlaceholder")}
              style={{
                width: "100%", border: "1px solid var(--border)", borderRadius: 6,
                padding: "6px 9px", fontSize: 13, background: "var(--bg)", color: "var(--text-primary)",
                marginBottom: 10, boxSizing: "border-box",
              }}
            />
            <datalist id="alfred-merge-project-options">
              {projectGroups.map(({ project }) => project).filter((p) => p && p !== mergingProject).map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button onClick={() => setMergingProject(null)} disabled={merging} style={btnStyle("transparent", "var(--text-secondary)", true)}>{t("notes.fileTree.cancel")}</button>
              <button onClick={handleMergeSubmit} disabled={merging || !mergeTarget.trim()} style={btnStyle("#C8914A", "#fff")}>
                {merging ? t("notes.fileTree.merging") : t("notes.fileTree.mergeConfirm")}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Renommer un projet (spec/07) — dialogue dédié (simple champ texte),
          distinct de la fusion même si l'action Rust sous-jacente est la même. */}
      {renamingProject && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(0,0,0,0.3)" }} onClick={() => !renamingProjectBusy && setRenamingProject(null)} />
          <div style={{
            position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            background: "var(--card-bg)", border: "1px solid var(--border)",
            borderRadius: 10, padding: 16, zIndex: 1000, width: 320,
            boxShadow: "0 8px 28px rgba(0,0,0,0.25)",
          }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-primary)", marginBottom: 10 }}>
              {t("notes.fileTree.renameProjectDialogTitle", { project: renamingProject })}
            </div>
            <input
              autoFocus
              value={renameProjectValue}
              onChange={(e) => setRenameProjectValue(e.target.value)}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => { if (e.key === "Enter") handleRenameProjectSubmit(); if (e.key === "Escape") setRenamingProject(null); }}
              style={{
                width: "100%", border: "1px solid var(--border)", borderRadius: 6,
                padding: "6px 9px", fontSize: 13, background: "var(--bg)", color: "var(--text-primary)",
                marginBottom: 10, boxSizing: "border-box",
              }}
            />
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button onClick={() => setRenamingProject(null)} disabled={renamingProjectBusy} style={btnStyle("transparent", "var(--text-secondary)", true)}>{t("notes.fileTree.cancel")}</button>
              <button onClick={handleRenameProjectSubmit} disabled={renamingProjectBusy || !renameProjectValue.trim()} style={btnStyle("#C8914A", "#fff")}>
                {t("notes.fileTree.ok")}
              </button>
            </div>
          </div>
        </>
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
  // Même traitement visuel que la vue Dossiers (spec/07, feedback tests —
  // « UI identique Folders ↔ Projects ») : estompé + badge « archivé ».
  const isArchived = note.status === "archived";
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
        opacity: isArchived ? 0.55 : 1,
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
      {isArchived && (
        <span style={{
          fontSize: 10, color: "var(--text-muted)", border: "1px solid var(--border)",
          borderRadius: 8, padding: "0 5px", flexShrink: 0, marginLeft: "auto",
        }}>
          {t("notes.fileTree.archivedBadge")}
        </span>
      )}
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
