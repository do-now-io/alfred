import { MdEdit, MdDelete } from "react-icons/md";

/** Menu contextuel « Renommer / Supprimer » d'une note (spec/07) — partagé
 *  entre l'arbre de fichiers (`FileTreeNode`) et les « Récents » (sidebar,
 *  `App.tsx`), qui n'avaient pas de menu du tout (clic droit natif du
 *  navigateur à la place). */
interface Props {
  x: number;
  y: number;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function NoteContextMenu({ x, y, onRename, onDelete, onClose }: Props) {
  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 999 }} onClick={onClose} />
      <div style={{
        position: "fixed", left: x, top: y,
        background: "var(--card-bg)", border: "1px solid var(--border)",
        borderRadius: 8, padding: 4, zIndex: 1000, minWidth: 140,
        boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
      }}>
        <button onClick={() => { onRename(); onClose(); }} style={menuItemStyle}>
          <MdEdit size={15} /> Renommer
        </button>
        <button onClick={() => { onDelete(); onClose(); }} style={{ ...menuItemStyle, color: "var(--danger)" }}>
          <MdDelete size={15} /> Supprimer
        </button>
      </div>
    </>
  );
}

export const menuItemStyle: React.CSSProperties = {
  // Tailwind's preflight sets `svg { display: block }`, which would stack the
  // icon above the label — flex + align-items keeps icon et texte sur une
  // même ligne (feedback tests).
  display: "flex", alignItems: "center", gap: 8,
  width: "100%", textAlign: "left",
  background: "none", border: "none", padding: "6px 12px",
  cursor: "pointer", fontSize: 13, color: "var(--text-primary)",
  borderRadius: 4,
};
