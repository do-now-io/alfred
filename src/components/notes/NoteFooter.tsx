import { MdUnfoldLess, MdUnfoldMore } from "react-icons/md";
import { useT } from "../../i18n";

interface Props {
  wordCount: number;
  charCount: number;
  propCount: number;
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
  wordCount, charCount, propCount,
  allCollapsed = false, onToggleCollapseAll,
}: Props) {
  const t = useT();
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
        {t("notes.footer.stats", {
          words: wordCount.toLocaleString(),
          chars: charCount.toLocaleString(),
          props: propCount,
        })}
      </span>
      {onToggleCollapseAll && (
        <button
          onClick={onToggleCollapseAll}
          title={allCollapsed ? t("notes.footer.expandAll") : t("notes.footer.collapseAll")}
          style={btnStyle(allCollapsed)}
        >
          {allCollapsed
            ? <MdUnfoldMore style={{ verticalAlign: "middle", marginRight: 4 }} />
            : <MdUnfoldLess style={{ verticalAlign: "middle", marginRight: 4 }} />}
          {allCollapsed ? t("notes.footer.expandAll") : t("notes.footer.collapseAll")}
        </button>
      )}
    </div>
  );
}
