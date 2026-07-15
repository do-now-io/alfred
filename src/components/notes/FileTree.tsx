import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MdMoveToInbox, MdAutorenew, MdCheck, MdErrorOutline, MdStickyNote2, MdFolderSpecial } from "react-icons/md";
import type { VaultNode } from "../../bindings/VaultNode";
import type { ProjectNote } from "../../bindings/ProjectNote";
import { useNotesStore } from "../../store/notesStore";
import FileTreeNode from "./FileTreeNode";

type IngestState = "idle" | "running" | "done" | "error";

interface Props {
  tree: VaultNode | null;
  vaultPath: string | null;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

export default function FileTree({ tree, vaultPath, selectedPath, onSelect }: Props) {
  const { createNote, deleteNote, renameNote, fetchTree } = useNotesStore();
  const [renaming, setRenaming] = useState<{ path: string; current: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [ingest, setIngest] = useState<IngestState>("idle");
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [view, setView] = useState<"folders" | "projects">("folders");
  const [projectNotes, setProjectNotes] = useState<ProjectNote[]>([]);

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

  // Group notes by project; named projects alpha, "Sans projet" last.
  const projectGroups = useMemo(() => {
    const map = new Map<string, ProjectNote[]>();
    for (const n of projectNotes) {
      const key = n.project?.trim() || "";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(n);
    }
    return [...map.entries()]
      .map(([project, notes]) => ({
        project,
        notes: notes.sort((a, b) => a.title.localeCompare(b.title)),
      }))
      .sort((a, b) => {
        if (a.project === "") return 1; // "Sans projet" last
        if (b.project === "") return -1;
        return a.project.localeCompare(b.project);
      });
  }, [projectNotes]);

  const handleCreate = async () => {
    if (!vaultPath) return;
    // New notes land in the vault's raw/ folder (the ingest source).
    await createNote(`${vaultPath}/raw`, "Nouvelle note");
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
      console.error("Ingestion échouée:", msg);
      setIngestError(msg);
      setIngest("error");
      setTimeout(() => setIngest("idle"), 5000);
    }
  };

  const handleDelete = async (path: string, name: string) => {
    if (window.confirm(`Supprimer "${name}" ?`)) {
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
          Notes
        </span>
        {vaultPath && (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <IngestButton state={ingest} error={ingestError} disabled={!selectedPath} onClick={handleIngest} />
            <button
              onClick={handleCreate}
              title="Nouvelle note"
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
          {([["folders", "Dossiers", <MdStickyNote2 key="f" />], ["projects", "Projets", <MdFolderSpecial key="p" />]] as const).map(([id, label, icon]) => (
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
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 4px" }}>
        {!vaultPath && (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)", textAlign: "center", lineHeight: 1.6 }}>
            Aucun dossier configuré.<br />
            <span style={{ color: "var(--text-secondary)" }}>Settings → Notes</span>
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
          />
        ))}

        {vaultPath && view === "projects" && (
          projectGroups.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)", textAlign: "center", lineHeight: 1.6 }}>
              Aucune note.
            </div>
          ) : projectGroups.map(({ project, notes }) => (
            <div key={project || "__none__"} style={{ marginBottom: 6 }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "5px 8px", fontSize: 11, fontWeight: 700,
                color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em",
              }}>
                <MdFolderSpecial size={13} style={{ color: project ? "var(--accent)" : "var(--text-muted)" }} />
                {project || "Sans projet"}
                <span style={{ marginLeft: "auto", opacity: 0.7 }}>{notes.length}</span>
              </div>
              {notes.map((n) => {
                const active = n.path === selectedPath;
                return (
                  <div
                    key={n.path}
                    onClick={() => onSelect(n.path)}
                    title={n.title}
                    style={{
                      display: "flex", alignItems: "center", gap: 7,
                      padding: "5px 8px 5px 22px", cursor: "pointer", fontSize: 13,
                      borderRadius: 6, color: active ? "var(--accent)" : "var(--text-secondary)",
                      background: active ? "var(--active-bg)" : "transparent",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}
                  >
                    <MdStickyNote2 size={14} style={{ flexShrink: 0 }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.title}</span>
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
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>Renommer</div>
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
            <button onClick={handleRenameSubmit} style={btnStyle("#C8914A", "#fff")}>OK</button>
            <button onClick={() => setRenaming(null)} style={btnStyle("transparent", "var(--text-secondary)", true)}>Annuler</button>
          </div>
        </div>
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
}: {
  state: IngestState;
  error: string | null;
  disabled: boolean;
  onClick: () => void;
}) {
  const running = state === "running";

  const { icon, color, title } = (() => {
    switch (state) {
      case "running":
        return {
          icon: <MdAutorenew style={{ display: "block", transformOrigin: "center", animation: "alfred-spin 0.8s linear infinite" }} />,
          color: "var(--accent)",
          title: "Ré-ingestion en cours…",
        };
      case "done":
        return {
          icon: <MdCheck style={{ animation: "alfred-pop 0.3s ease" }} />,
          color: "#34C759",
          title: "Ré-ingestion terminée — compte-rendu régénéré",
        };
      case "error":
        return {
          icon: <MdErrorOutline style={{ animation: "alfred-pop 0.3s ease" }} />,
          color: "var(--danger)",
          title: error ? `Ré-ingestion échouée : ${error}` : "Ré-ingestion échouée",
        };
      default:
        return {
          icon: <MdMoveToInbox />,
          color: disabled ? "var(--text-muted)" : "var(--text-secondary)",
          title: disabled ? "Sélectionne une note à ré-ingérer" : "Ré-ingérer la note sélectionnée",
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
