import { useState } from "react";
import { MdEdit, MdDelete, MdCreateNewFolder } from "react-icons/md";
import type { VaultNode } from "../../bindings/VaultNode";
import { useNotesStore } from "../../store/notesStore";
import { NoteTypeIcon } from "../../utils/noteType";
import NoteContextMenu, { menuItemStyle } from "./NoteContextMenu";
import { useT } from "../../i18n";

/** MIME custom du glisser-déposer interne (spec/07) — déjà utilisé pour déposer
 *  une note sur un groupe de projet ; réutilisé ici pour la déposer sur un
 *  dossier physique de l'arbre et la déplacer. */
const DRAG_MIME = "text/alfred-note-path";

interface Props {
  node: VaultNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onDelete: (path: string, name: string) => void;
  onRename: (path: string, currentName: string) => void;
  onMove: (notePath: string, destFolder: string) => void;
  onCreateFolder: (parentPath: string) => void;
  onDeleteFolder: (path: string, name: string) => void;
  onRenameFolder: (path: string, currentName: string) => void;
}

export default function FileTreeNode({
  node, depth, selectedPath, onSelect, onDelete, onRename, onMove, onCreateFolder, onDeleteFolder, onRenameFolder,
}: Props) {
  const t = useT();
  const { expandedPaths, toggleExpanded } = useNotesStore();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const isExpanded = expandedPaths.has(node.path);
  const isSelected = !node.is_dir && node.path === selectedPath;
  const isArchived = node.status === "archived";
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
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(DRAG_MIME)) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation(); // ne pas aussi déclencher le dépôt racine du conteneur
            setDragOver(false);
            const path = e.dataTransfer.getData(DRAG_MIME);
            if (path && path !== node.path) onMove(path, node.path);
          }}
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "4px 8px 4px 0", paddingLeft: `${8 + indent}px`,
            cursor: "pointer", fontSize: 13,
            color: "var(--text-secondary)",
            userSelect: "none",
            background: dragOver ? "var(--active-bg)" : "transparent",
            outline: dragOver ? "1px dashed var(--accent)" : "none",
            borderRadius: 4,
          }}
          onMouseEnter={e => { if (!dragOver) e.currentTarget.style.background = "var(--active-bg)"; }}
          onMouseLeave={e => { if (!dragOver) e.currentTarget.style.background = "transparent"; }}
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
            onMove={onMove}
            onCreateFolder={onCreateFolder}
            onDeleteFolder={onDeleteFolder}
            onRenameFolder={onRenameFolder}
          />
        ))}

        {contextMenu && (
          <>
            <div
              style={{ position: "fixed", inset: 0, zIndex: 999 }}
              onClick={() => setContextMenu(null)}
            />
            <div style={{
              position: "fixed", left: contextMenu.x, top: contextMenu.y,
              background: "var(--card-bg)", border: "1px solid var(--border)",
              borderRadius: 8, padding: 4, zIndex: 1000, minWidth: 160,
              boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
            }}>
              <button
                onClick={() => { onCreateFolder(node.path); setContextMenu(null); }}
                style={menuItemStyle}
              >
                <MdCreateNewFolder size={15} /> {t("notes.contextMenu.newFolder")}
              </button>
              <button
                onClick={() => { onRenameFolder(node.path, node.name); setContextMenu(null); }}
                style={menuItemStyle}
              >
                <MdEdit size={15} /> {t("notes.contextMenu.rename")}
              </button>
              <button
                onClick={() => { onDeleteFolder(node.path, node.name); setContextMenu(null); }}
                style={{ ...menuItemStyle, color: "var(--danger)" }}
              >
                <MdDelete size={15} /> {t("notes.contextMenu.delete")}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <div
        onClick={() => onSelect(node.path)}
        onContextMenu={handleContextMenu}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_MIME, node.path);
          e.dataTransfer.effectAllowed = "move";
        }}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "4px 8px 4px 0", paddingLeft: `${20 + indent}px`,
          cursor: "pointer", fontSize: 13,
          color: isSelected ? "var(--accent)" : "var(--text-primary)",
          background: isSelected ? "var(--active-bg)" : "transparent",
          borderRadius: 4,
          userSelect: "none",
          overflow: "hidden", whiteSpace: "nowrap",
          opacity: isArchived ? 0.55 : 1,
        }}
        onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "var(--bg)"; }}
        onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
      >
        {/* Icône de type à l'œil (spec/07) — dérivée du dossier / nom de fichier. */}
        <NoteTypeIcon path={node.path} size={13} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.name}</span>
        {isArchived && (
          <span style={{
            fontSize: 10, color: "var(--text-muted)", border: "1px solid var(--border)",
            borderRadius: 8, padding: "0 5px", flexShrink: 0, marginLeft: "auto",
          }}>
            {t("notes.fileTree.archivedBadge")}
          </span>
        )}
      </div>

      {contextMenu && (
        <NoteContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onRename={() => onRename(node.path, node.name)}
          onDelete={() => onDelete(node.path, node.name)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}
