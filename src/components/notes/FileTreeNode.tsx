import { useState } from "react";
import { MdEdit, MdDelete } from "react-icons/md";
import type { VaultNode } from "../../bindings/VaultNode";
import { useNotesStore } from "../../store/notesStore";
import { NoteTypeIcon } from "../../utils/noteType";

interface Props {
  node: VaultNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onDelete: (path: string, name: string) => void;
  onRename: (path: string, currentName: string) => void;
}

export default function FileTreeNode({ node, depth, selectedPath, onSelect, onDelete, onRename }: Props) {
  const { expandedPaths, toggleExpanded } = useNotesStore();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const isExpanded = expandedPaths.has(node.path);
  const isSelected = !node.is_dir && node.path === selectedPath;
  const indent = depth * 16;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  if (node.is_dir) {
    return (
      <div>
        <div
          onClick={() => toggleExpanded(node.path)}
          onContextMenu={handleContextMenu}
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "4px 8px 4px 0", paddingLeft: `${8 + indent}px`,
            cursor: "pointer", fontSize: 13,
            color: "var(--text-secondary)",
            userSelect: "none",
          }}
          onMouseEnter={e => (e.currentTarget.style.background = "var(--active-bg)")}
          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
        >
          <span style={{ fontSize: 10, width: 12, flexShrink: 0, color: "var(--text-muted)" }}>
            {isExpanded ? "▼" : "▶"}
          </span>
          <span>{node.name}</span>
        </div>
        {isExpanded && node.children.map(child => (
          <FileTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
            onDelete={onDelete}
            onRename={onRename}
          />
        ))}
      </div>
    );
  }

  return (
    <>
      <div
        onClick={() => onSelect(node.path)}
        onContextMenu={handleContextMenu}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "4px 8px 4px 0", paddingLeft: `${20 + indent}px`,
          cursor: "pointer", fontSize: 13,
          color: isSelected ? "var(--accent)" : "var(--text-primary)",
          background: isSelected ? "var(--active-bg)" : "transparent",
          borderRadius: 4,
          userSelect: "none",
          overflow: "hidden", whiteSpace: "nowrap",
        }}
        onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "var(--bg)"; }}
        onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
      >
        {/* Icône de type à l'œil (spec/07) — dérivée du dossier / nom de fichier. */}
        <NoteTypeIcon path={node.path} size={13} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.name}</span>
      </div>

      {contextMenu && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999 }}
            onClick={() => setContextMenu(null)}
          />
          <div style={{
            position: "fixed", left: contextMenu.x, top: contextMenu.y,
            background: "var(--card-bg)", border: "1px solid var(--border)",
            borderRadius: 8, padding: 4, zIndex: 1000, minWidth: 140,
            boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
          }}>
            <button
              onClick={() => { onRename(node.path, node.name); setContextMenu(null); }}
              style={menuItemStyle}
            >
              <MdEdit style={{ verticalAlign: "middle", marginRight: 6 }} /> Renommer
            </button>
            <button
              onClick={() => { onDelete(node.path, node.name); setContextMenu(null); }}
              style={{ ...menuItemStyle, color: "var(--danger)" }}
            >
              <MdDelete style={{ verticalAlign: "middle", marginRight: 6 }} /> Supprimer
            </button>
          </div>
        </>
      )}
    </>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: "block", width: "100%", textAlign: "left",
  background: "none", border: "none", padding: "6px 12px",
  cursor: "pointer", fontSize: 13, color: "var(--text-primary)",
  borderRadius: 4,
};
