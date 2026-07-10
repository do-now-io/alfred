import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useLocation } from "react-router-dom";
import { MdBugReport, MdLightbulb, MdFavorite, MdClose, MdCheckCircle, MdWarning, MdContentPaste } from "react-icons/md";

// Feedback (spec/14) — text + optional images (paste screenshots) + optional
// contact email, sent via the `submit_feedback` command (Rust owns the network
// call — spec/15 §E, stores in Postgres, no email/S3 in v1).

type Category = "bug" | "feature" | "praise";

const CATEGORIES: { id: Category; label: string; icon: React.ReactNode }[] = [
  { id: "bug", label: "Bug", icon: <MdBugReport /> },
  { id: "feature", label: "Suggestion", icon: <MdLightbulb /> },
  { id: "praise", label: "Compliment", icon: <MdFavorite /> },
];

interface PastedImage {
  id: string;
  filename: string;
  contentType: string;
  data: string; // base64, no data: prefix
  previewUrl: string;
}

function readImageFile(file: File): Promise<{ data: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = reader.result as string; // "data:<type>;base64,<data>"
      const [, data] = result.split(",");
      resolve({ data, contentType: file.type || "image/png" });
    };
    reader.readAsDataURL(file);
  });
}

export default function Feedback() {
  const location = useLocation();
  // Arriving via the widget's « Formulaire détaillé » link carries the view the
  // user was actually on; a direct visit reports /feedback itself.
  const originView: string = location.state?.from ?? "/feedback";
  const [category, setCategory] = useState<Category>("bug");
  const [text, setText] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [images, setImages] = useState<PastedImage[]>([]);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const addImage = async (file: File) => {
    if (images.length >= 5) return;
    const { data, contentType } = await readImageFile(file);
    setImages((prev) => [
      ...prev,
      { id: `${Date.now()}-${prev.length}`, filename: file.name || "capture.png", contentType, data, previewUrl: `data:${contentType};base64,${data}` },
    ]);
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith("image/"));
    for (const item of items) {
      const file = item.getAsFile();
      if (file) await addImage(file);
    }
  };

  const removeImage = (id: string) => setImages((prev) => prev.filter((i) => i.id !== id));

  const canSend = text.trim().length > 0 && state !== "sending";

  const send = async () => {
    if (!canSend) return;
    setState("sending");
    setError(null);
    try {
      await invoke("submit_feedback", {
        category,
        text: text.trim(),
        contactEmail: contactEmail.trim() || null,
        view: originView,
        images: images.map((i) => ({ filename: i.filename, contentType: i.contentType, data: i.data })),
      });
      setState("sent");
      setText("");
      setContactEmail("");
      setImages([]);
      setTimeout(() => setState("idle"), 3000);
    } catch (e) {
      setError(String(e));
      setState("error");
      // Text/images/category are intentionally preserved on failure (spec/14).
    }
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", display: "flex", justifyContent: "center", padding: "40px 24px" }}>
      <div style={{ width: "100%", maxWidth: 560, display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <h1 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 700, color: "var(--text-primary)" }}>Feedback</h1>
          <p style={{ margin: 0, fontSize: 13.5, color: "var(--text-secondary)" }}>
            Un bug, une idée, ou juste un mot gentil — ça nous aide à améliorer Alfred.
          </p>
        </div>

        <div className="card" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Category */}
          <div style={{ display: "flex", gap: 8 }}>
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setCategory(c.id)}
                style={{
                  flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                  padding: "10px 8px", borderRadius: 10, cursor: "pointer",
                  border: category === c.id ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                  background: category === c.id ? "var(--active-bg)" : "transparent",
                  color: category === c.id ? "var(--accent)" : "var(--text-secondary)",
                  fontSize: 12.5, fontWeight: 500,
                }}
              >
                <span style={{ fontSize: 18 }}>{c.icon}</span>
                {c.label}
              </button>
            ))}
          </div>

          {/* Text + paste zone */}
          <div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={handlePaste}
              placeholder="Décrivez votre retour — collez une capture d'écran directement ici si besoin (Ctrl/Cmd+V)…"
              rows={6}
              style={{
                width: "100%", resize: "vertical", boxSizing: "border-box",
                fontFamily: "inherit", fontSize: 13.5, lineHeight: 1.5,
                color: "var(--text-primary)", background: "var(--bg)",
                border: "1px solid var(--border)", borderRadius: 8,
                padding: "10px 12px", outline: "none",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 11.5, color: "var(--text-muted)" }}>
              <MdContentPaste size={13} /> Coller une image l'ajoute à votre retour (jusqu'à 5)
            </div>
          </div>

          {/* Image thumbnails */}
          {images.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {images.map((img) => (
                <div key={img.id} style={{ position: "relative", width: 72, height: 72 }}>
                  <img
                    src={img.previewUrl}
                    alt={img.filename}
                    style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)" }}
                  />
                  <button
                    onClick={() => removeImage(img.id)}
                    title="Retirer"
                    style={{
                      position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%",
                      background: "var(--danger)", color: "#fff", border: "2px solid var(--card-bg)",
                      cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
                    }}
                  >
                    <MdClose size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Contact email */}
          <input
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="Email de contact (facultatif — pour qu'on puisse vous répondre)"
            style={{
              border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px",
              fontSize: 13, background: "var(--bg)", color: "var(--text-primary)",
            }}
          />

          {state === "error" && error && (
            <div style={{ fontSize: 12.5, color: "var(--danger)", display: "flex", alignItems: "center", gap: 6 }}>
              <MdWarning size={15} /> {error} — votre texte est conservé, réessayez.
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              onClick={send}
              disabled={!canSend}
              style={{
                background: canSend ? "var(--accent)" : "var(--border)", color: "#fff", border: "none",
                borderRadius: 8, padding: "9px 20px", cursor: canSend ? "pointer" : "not-allowed",
                fontSize: 13.5, fontWeight: 500,
              }}
            >
              {state === "sending" ? "Envoi…" : "Envoyer"}
            </button>
            {state === "sent" && (
              <span style={{ fontSize: 13, color: "#34C759", display: "flex", alignItems: "center", gap: 6 }}>
                <MdCheckCircle size={16} /> Merci, c'est envoyé !
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
