import { useState } from "react";
import { MdArrowBack, MdHistory } from "react-icons/md";

interface Props {
  filePath: string;
  vaultPath: string;
  history: string[]; // previous note paths, most recent last
  onBack: () => void;
  onOpenHistoryEntry: (path: string) => void;
  /** Enregistrement en cours sur cette note (spec/16) — badge « En direct ». */
  live?: boolean;
}

function stem(path: string): string {
  return path.split("/").pop()?.replace(/\.md$/, "") ?? path;
}

const navButtonStyle = (enabled: boolean): React.CSSProperties => ({
  background: "none",
  border: "none",
  borderRadius: 6,
  padding: "3px 5px",
  cursor: enabled ? "pointer" : "default",
  color: enabled ? "var(--text-secondary)" : "var(--text-muted)",
  opacity: enabled ? 1 : 0.4,
  display: "flex",
  alignItems: "center",
});

export default function NoteBreadcrumb({ filePath, vaultPath, history, onBack, onOpenHistoryEntry, live }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);

  const canGoBack = history.length > 0;
  const prevName = canGoBack ? stem(history[history.length - 1]) : null;

  const relative = filePath.startsWith(vaultPath)
    ? filePath.slice(vaultPath.length).replace(/^\//, "")
    : filePath;

  const parts = relative.replace(/\.md$/, "").split("/").filter(Boolean);

  return (
    <div style={{
      padding: "6px 16px",
      fontSize: 12, color: "var(--text-muted)",
      borderBottom: "1px solid var(--border)",
      display: "flex", alignItems: "center", gap: 4,
      flexShrink: 0,
      position: "relative",
    }}>
      <button
        onClick={canGoBack ? onBack : undefined}
        disabled={!canGoBack}
        title={prevName ? `Revenir à « ${prevName} »` : "Aucune note précédente"}
        style={navButtonStyle(canGoBack)}
      >
        <MdArrowBack size={15} />
      </button>

      <button
        onClick={canGoBack ? () => setMenuOpen(o => !o) : undefined}
        disabled={!canGoBack}
        title="Historique des notes visitées"
        style={navButtonStyle(canGoBack)}
      >
        <MdHistory size={15} />
      </button>

      {menuOpen && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 99 }} onClick={() => setMenuOpen(false)} />
          <div style={{
            position: "absolute", top: "100%", left: 40, zIndex: 100,
            background: "var(--card-bg)", border: "1px solid var(--border)",
            borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
            minWidth: 180, maxWidth: 300, padding: "4px 0",
          }}>
            {[...history].reverse().map(p => (
              <div
                key={p}
                onClick={() => { setMenuOpen(false); onOpenHistoryEntry(p); }}
                style={{
                  padding: "6px 14px", fontSize: 13, cursor: "pointer",
                  color: "var(--text-primary)",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--active-bg)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                {stem(p)}
              </div>
            ))}
          </div>
        </>
      )}

      <span style={{ width: 1, height: 14, background: "var(--border)", margin: "0 6px" }} />

      {parts.map((part, i) => (
        <span key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {i > 0 && <span style={{ opacity: 0.5 }}>/</span>}
          <span style={{ color: i === parts.length - 1 ? "var(--text-primary)" : "var(--text-muted)" }}>
            {part}
          </span>
        </span>
      ))}

      {live && (
        <span style={{
          marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5,
          fontSize: 11, fontWeight: 600, color: "var(--danger)",
          padding: "2px 8px", borderRadius: 999,
          border: "1px solid var(--danger)",
        }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--danger)" }} />
          En direct
        </span>
      )}
    </div>
  );
}
