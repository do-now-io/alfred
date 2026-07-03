import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MdMoveToInbox, MdAutorenew, MdCheck, MdErrorOutline } from "react-icons/md";
import type { VaultNode } from "../../bindings/VaultNode";
import { useNotesStore } from "../../store/notesStore";
import FileTreeNode from "./FileTreeNode";
import IngestModal, { type IngestModalState } from "./IngestModal";

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
  const [logs, setLogs] = useState<string[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalStatus, setModalStatus] = useState<IngestModalState>("running");

  const handleCreate = async () => {
    if (!vaultPath) return;
    // New notes land in the vault's raw/ folder (the ingest source).
    await createNote(`${vaultPath}/raw`, "Nouvelle note");
  };

  const handleIngest = async () => {
    if (ingest === "running" || !vaultPath) return;
    setIngest("running");
    setIngestError(null);
    setLogs([]);
    setModalStatus("running");
    setModalOpen(true);

    const unlisten = await listen<string>("ingest-log", (e) => {
      setLogs(prev => [...prev, e.payload]);
    });

    try {
      await invoke<string>("run_ingest");
      await fetchTree(); // surface freshly ingested notes
      setIngest("done");
      setModalStatus("done");
      setTimeout(() => setIngest("idle"), 2500);
    } catch (e) {
      const msg = String(e);
      console.error("Ingestion échouée:", msg);
      setIngestError(msg);
      setLogs(prev => [...prev, `✗ ${msg}`]);
      setIngest("error");
      setModalStatus("error");
      setTimeout(() => setIngest("idle"), 5000);
    } finally {
      unlisten();
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
            <IngestButton state={ingest} error={ingestError} onClick={handleIngest} />
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

      {/* Tree */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 4px" }}>
        {!vaultPath && (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)", textAlign: "center", lineHeight: 1.6 }}>
            Aucun dossier configuré.<br />
            <span style={{ color: "var(--text-secondary)" }}>Settings → Notes</span>
          </div>
        )}

        {tree && tree.children.map(node => (
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

      {modalOpen && (
        <IngestModal
          logs={logs}
          state={modalStatus}
          error={ingestError}
          onClose={() => setModalOpen(false)}
        />
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

function IngestButton({ state, error, onClick }: { state: IngestState; error: string | null; onClick: () => void }) {
  const running = state === "running";

  const { icon, color, title } = (() => {
    switch (state) {
      case "running":
        return {
          icon: <MdAutorenew style={{ display: "block", transformOrigin: "center", animation: "alfred-spin 0.8s linear infinite" }} />,
          color: "var(--accent)",
          title: "Ingestion en cours…",
        };
      case "done":
        return {
          icon: <MdCheck style={{ animation: "alfred-pop 0.3s ease" }} />,
          color: "#34C759",
          title: "Ingestion terminée — wiki mis à jour",
        };
      case "error":
        return {
          icon: <MdErrorOutline style={{ animation: "alfred-pop 0.3s ease" }} />,
          color: "var(--danger)",
          title: error ? `Ingestion échouée : ${error}` : "Ingestion échouée",
        };
      default:
        return {
          icon: <MdMoveToInbox />,
          color: "var(--text-secondary)",
          title: "Ingérer le dossier raw/ dans le wiki",
        };
    }
  })();

  return (
    <button
      onClick={onClick}
      disabled={running}
      title={title}
      style={{
        background: "none", border: "none",
        cursor: running ? "wait" : "pointer",
        color, fontSize: 17, lineHeight: 1, padding: 2,
        display: "inline-flex", alignItems: "center",
        transition: "color 0.15s",
      }}
    >
      {icon}
    </button>
  );
}
