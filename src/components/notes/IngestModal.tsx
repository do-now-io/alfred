import { useEffect, useRef } from "react";
import { MdAutorenew, MdCheckCircle, MdErrorOutline, MdClose } from "react-icons/md";

export type IngestModalState = "running" | "done" | "error";

interface Props {
  logs: string[];
  state: IngestModalState;
  error: string | null;
  onClose: () => void;
}

export default function IngestModal({ logs, state, error, onClose }: Props) {
  const bodyRef = useRef<HTMLPreElement>(null);
  const running = state === "running";

  // Auto-scroll to the latest line.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
      }}
      onClick={running ? undefined : onClose}
    >
      <div
        className="card"
        style={{
          width: 580, maxWidth: "90vw", maxHeight: "80vh",
          padding: 0, display: "flex", flexDirection: "column", overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: "14px 18px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <span style={{ color: "var(--accent)", fontSize: 16, display: "flex" }}>✦</span>
          <span style={{ fontWeight: 600, fontSize: 15, color: "var(--text-primary)" }}>Ingestion</span>
          <StatusPill state={state} />
          <button
            onClick={onClose}
            disabled={running}
            title={running ? "Ingestion en cours…" : "Fermer"}
            style={{
              marginLeft: "auto", background: "none", border: "none",
              cursor: running ? "not-allowed" : "pointer",
              color: "var(--text-muted)", fontSize: 18, display: "inline-flex", alignItems: "center",
              opacity: running ? 0.4 : 1,
            }}
          >
            <MdClose />
          </button>
        </div>

        {/* Logs */}
        <pre
          ref={bodyRef}
          style={{
            margin: 0, flex: 1, overflow: "auto", padding: "14px 18px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 12, lineHeight: 1.65, color: "var(--text-secondary)",
            background: "var(--bg)", whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}
        >
          {logs.length === 0 ? "En attente de la sortie de Claude…" : logs.join("\n")}
        </pre>

        {/* Error footer */}
        {state === "error" && error && (
          <div style={{
            padding: "10px 18px", borderTop: "1px solid var(--border)",
            color: "var(--danger)", fontSize: 12, lineHeight: 1.5,
            maxHeight: 120, overflow: "auto",
          }}>
            ⚠ {error}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusPill({ state }: { state: IngestModalState }) {
  if (state === "running") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--accent)" }}>
        <MdAutorenew style={{ display: "block", transformOrigin: "center", animation: "alfred-spin 0.8s linear infinite" }} />
        En cours…
      </span>
    );
  }
  if (state === "done") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "#34C759" }}>
        <MdCheckCircle style={{ display: "block" }} /> Terminé
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--danger)" }}>
      <MdErrorOutline style={{ display: "block" }} /> Échec
    </span>
  );
}
