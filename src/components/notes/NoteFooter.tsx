import { MdEdit, MdVisibility, MdUnfoldLess, MdUnfoldMore } from "react-icons/md";

interface Props {
  wordCount: number;
  charCount: number;
  propCount: number;
  editMode: boolean;
  onToggleEdit: () => void;
  allCollapsed?: boolean;
  onToggleCollapseAll?: () => void;
}

const btnStyle = (active: boolean): React.CSSProperties => ({
  background: active ? "var(--active-bg)" : "none",
  border: "1px solid var(--border)",
  borderRadius: 5, padding: "3px 8px", cursor: "pointer",
  fontSize: 12, color: active ? "var(--accent)" : "var(--text-muted)",
  // Tailwind's preflight sets `svg { display: block }`, which would stack the
  // icon above the label — inline-flex keeps icon + text on one row.
  display: "inline-flex", alignItems: "center", whiteSpace: "nowrap",
});

export default function NoteFooter({
  wordCount, charCount, propCount, editMode, onToggleEdit,
  allCollapsed = false, onToggleCollapseAll,
}: Props) {
  return (
    <div style={{
      borderTop: "1px solid var(--border)",
      padding: "6px 24px",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      fontSize: 12, color: "var(--text-muted)",
      background: "var(--card-bg)",
      flexShrink: 0,
    }}>
      <span>
        {wordCount.toLocaleString()} mots · {charCount.toLocaleString()} caractères · {propCount} propriétés
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {!editMode && onToggleCollapseAll && (
          <button
            onClick={onToggleCollapseAll}
            title={allCollapsed ? "Tout déplier" : "Tout replier"}
            style={btnStyle(allCollapsed)}
          >
            {allCollapsed
              ? <MdUnfoldMore style={{ verticalAlign: "middle", marginRight: 4 }} />
              : <MdUnfoldLess style={{ verticalAlign: "middle", marginRight: 4 }} />}
            {allCollapsed ? "Tout déplier" : "Tout replier"}
          </button>
        )}
        <button
          onClick={onToggleEdit}
          title={editMode ? "Mode lecture" : "Mode édition"}
          style={btnStyle(editMode)}
        >
          {editMode ? <MdVisibility style={{ verticalAlign: "middle", marginRight: 4 }} /> : <MdEdit style={{ verticalAlign: "middle", marginRight: 4 }} />}
          {editMode ? "Lecture" : "Éditer"}
        </button>
      </div>
    </div>
  );
}
