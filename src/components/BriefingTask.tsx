import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";
import { useNotesStore } from "../store/notesStore";
import BriefingContent from "./BriefingContent";
import type { CalendarEvent } from "../bindings/CalendarEvent";

interface Props {
  event: CalendarEvent;
  onClose: () => void;
}

export default function BriefingTask({ event, onClose }: Props) {
  const [briefing, setBriefing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const navigate = useNavigate();
  const openNoteByRef = useNotesStore(s => s.openNoteByRef);

  useEffect(() => {
    setLoading(true);
    setBriefing(null);
    setError(null);
    invoke<string>("generate_event_briefing", { eventId: event.id })
      .then(setBriefing)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [event.id]);

  const handleWikilink = async (ref: string) => {
    console.log(`[wikilink] BriefingTask: handleWikilink ref="${ref}"`);
    const found = await openNoteByRef(ref);
    if (found) {
      navigate("/notes");
    } else {
      console.warn(`[wikilink] BriefingTask: note not found: ${ref}`);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
        <span style={{ color: "var(--accent)", fontSize: 16, marginTop: 1 }}>✦</span>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
            {event.title}
          </h2>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
            {new Date(event.start_at).toLocaleString("fr-FR", {
              weekday: "long", day: "numeric", month: "long",
              hour: "2-digit", minute: "2-digit",
            })}
            {event.location ? ` — ${event.location}` : ""}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "none", border: "1px solid var(--border)", borderRadius: 6,
            padding: "3px 10px", cursor: "pointer", fontSize: 12, color: "var(--text-secondary)",
            transition: "background 0.15s, border-color 0.15s, color 0.15s",
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = "var(--active-bg)";
            e.currentTarget.style.borderColor = "var(--accent)";
            e.currentTarget.style.color = "var(--accent)";
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = "none";
            e.currentTarget.style.borderColor = "var(--border)";
            e.currentTarget.style.color = "var(--text-secondary)";
          }}
        >
          ✕ Fermer
        </button>
      </div>

      {loading && (
        <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "12px 0" }}>
          ⏳ Alfred parcourt vos notes et vos tâches…
        </div>
      )}
      {error && (
        <div style={{ fontSize: 13, color: "var(--danger)", padding: "8px 0" }}>
          ⚠ {error}
        </div>
      )}
      {!loading && !error && briefing && (
        <BriefingContent markdown={briefing} onWikilink={handleWikilink} />
      )}
    </div>
  );
}
