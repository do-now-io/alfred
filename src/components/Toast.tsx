import { useToastStore } from "../store/toastStore";

/** Rendu une seule fois (App.tsx) — feedback visible pour un lien interne dont
 *  la cible n'est pas trouvée (spec/23), au lieu d'un clic mort silencieux. */
export default function Toast() {
  const message = useToastStore((s) => s.message);
  const hide = useToastStore((s) => s.hide);
  if (!message) return null;

  return (
    <div style={{
      position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 2500,
      maxWidth: 420, padding: "10px 14px", borderRadius: 10,
      background: "var(--card-bg)", border: "1px solid var(--border)",
      boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
      display: "flex", alignItems: "center", gap: 10, fontSize: 13,
      color: "var(--text-primary)",
    }}>
      <span>{message}</span>
      <button
        onClick={hide}
        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 14, padding: 0, lineHeight: 1 }}
      >
        ✕
      </button>
    </div>
  );
}
