import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLocation, useNavigate } from "react-router-dom";
import { MdOutlineFeedback, MdCheckCircle, MdWarning } from "react-icons/md";

// Quick feedback (spec/14) — always-available topbar icon opening a small
// popover (textarea + « Envoyer »). Sends category "quick" plus the current
// view (route pathname). The detailed form (categories, screenshots, contact
// email) lives on /feedback, reachable from the popover footer since it no
// longer has a sidebar entry.

export default function FeedbackWidget() {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open]);

  const canSend = text.trim().length > 0 && state !== "sending";

  const send = async () => {
    if (!canSend) return;
    setState("sending");
    setError(null);
    try {
      await invoke("submit_feedback", {
        category: "quick",
        text: text.trim(),
        contactEmail: null,
        view: location.pathname,
        images: [],
      });
      setState("sent");
      setText("");
      setTimeout(() => {
        setOpen(false);
        setState("idle");
      }, 1500);
    } catch (e) {
      setError(String(e));
      setState("error");
      // Text is intentionally preserved on failure (spec/14).
    }
  };

  return (
    <div ref={rootRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title="Envoyer un retour"
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 30, height: 30, padding: 0, borderRadius: 8,
          background: open || hover ? "var(--active-bg)" : "transparent",
          border: "none", cursor: "pointer",
          color: open || hover ? "var(--accent)" : "var(--text-muted)",
          fontSize: 18,
        }}
      >
        <MdOutlineFeedback />
      </button>

      {open && (
        <div style={{
          position: "fixed", top: 58, right: 24, zIndex: 1500,
          width: 300, padding: "12px 14px", borderRadius: 12,
          background: "var(--card-bg)", border: "1px solid var(--border)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
          display: "flex", flexDirection: "column", gap: 10, fontSize: 13,
        }}>
          <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>Un retour ?</div>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
            }}
            placeholder="Un bug, une idée, une remarque…"
            rows={3}
            autoFocus
            style={{
              width: "100%", resize: "vertical", boxSizing: "border-box",
              fontFamily: "inherit", fontSize: 13, lineHeight: 1.5,
              color: "var(--text-primary)", background: "var(--bg)",
              border: "1px solid var(--border)", borderRadius: 8,
              padding: "8px 10px", outline: "none",
            }}
          />

          {state === "error" && error && (
            <div style={{ fontSize: 12, color: "var(--danger)", display: "flex", alignItems: "flex-start", gap: 6 }}>
              <MdWarning size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{error} — votre texte est conservé, réessayez.</span>
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <button
              onClick={() => {
                navigate("/feedback", { state: { from: location.pathname } });
                setOpen(false);
              }}
              title="Catégorie, captures d'écran, email de contact"
              style={{
                background: "none", border: "none", cursor: "pointer", padding: 0,
                fontSize: 11.5, color: "var(--text-muted)", textDecoration: "underline",
              }}
            >
              Formulaire détaillé
            </button>
            {state === "sent" ? (
              <span style={{ fontSize: 12.5, color: "#34C759", display: "flex", alignItems: "center", gap: 5 }}>
                <MdCheckCircle size={15} /> Merci !
              </span>
            ) : (
              <button
                onClick={send}
                disabled={!canSend}
                style={{
                  background: canSend ? "var(--accent)" : "var(--border)", color: "#fff", border: "none",
                  borderRadius: 8, padding: "6px 14px", cursor: canSend ? "pointer" : "not-allowed",
                  fontSize: 12.5, fontWeight: 500,
                }}
              >
                {state === "sending" ? "Envoi…" : "Envoyer"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
