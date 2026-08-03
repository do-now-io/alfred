import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MdLocationOn, MdPeople } from "react-icons/md";
import type { CalendarEvent } from "../bindings/CalendarEvent";
import type { GoogleAuthStatus } from "../bindings/GoogleAuthStatus";
import { useT } from "../i18n";

// Écran Agenda (spec/02 §3a) — Google Calendar, lecture seule. Aucune
// création/modification d'événement depuis Alfred (hors scope explicite).

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}h${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

function EventCard({ event }: { event: CalendarEvent }) {
  const t = useT();
  return (
    <div style={{
      padding: "12px 16px", borderRadius: 10, border: "1px solid var(--border)",
      background: "var(--card-bg)", marginBottom: 8,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--accent)", flexShrink: 0, minWidth: 56 }}>
          {event.all_day ? t("calendar.allDay") : formatTime(event.start_at)}
        </span>
        <span style={{ fontSize: 14, color: "var(--text-primary)", fontWeight: 500 }}>{event.title}</span>
      </div>
      {(event.location || event.attendees.length > 0) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 6, marginLeft: 66, fontSize: 12.5, color: "var(--text-secondary)" }}>
          {event.location && (
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <MdLocationOn size={13} /> {event.location}
            </span>
          )}
          {event.attendees.length > 0 && (
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <MdPeople size={13} /> {event.attendees.join(", ")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default function Agenda() {
  const t = useT();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"today" | "week">("today");
  const [connected, setConnected] = useState<boolean | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchEvents = useCallback(async (period: "today" | "week") => {
    setLoading(true);
    try {
      const evs = await invoke<CalendarEvent[]>(period === "today" ? "get_today_events" : "get_week_events");
      setEvents(evs);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    invoke<GoogleAuthStatus>("get_calendar_auth_status")
      .then((s) => setConnected(s.connected))
      .catch(() => setConnected(false));
  }, []);

  useEffect(() => { fetchEvents(tab); }, [tab, fetchEvents]);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    listen("calendar-synced", () => fetchEvents(tab)).then((fn) => { unsub = fn; });
    return () => unsub?.();
  }, [tab, fetchEvents]);

  // Regroupe par jour pour la vue semaine (spec/02 §3a).
  const grouped: { day: string; items: CalendarEvent[] }[] = [];
  for (const ev of events) {
    const day = formatDay(ev.start_at);
    const last = grouped[grouped.length - 1];
    if (last && last.day === day) last.items.push(ev);
    else grouped.push({ day, items: [ev] });
  }

  return (
    <div style={{ padding: 32, maxWidth: 720, overflowY: "auto", height: "100%" }}>
      <h1 style={{ margin: "0 0 20px", fontSize: 22, fontWeight: 600, color: "var(--text-primary)" }}>
        {t("calendar.title")}
      </h1>

      {connected === false ? (
        <div style={{
          padding: 20, borderRadius: 10, border: "1px solid var(--border)",
          background: "var(--card-bg)", color: "var(--text-secondary)", fontSize: 14,
        }}>
          <p style={{ margin: "0 0 12px" }}>{t("calendar.notConnected")}</p>
          <button
            onClick={() => navigate("/settings")}
            style={{
              background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6,
              padding: "6px 14px", cursor: "pointer", fontSize: 13,
            }}
          >
            {t("calendar.goToSettings")}
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            {(["today", "week"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                style={{
                  padding: "6px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer",
                  border: "1px solid var(--border)",
                  background: tab === k ? "var(--active-bg)" : "transparent",
                  color: tab === k ? "var(--accent)" : "var(--text-secondary)",
                  fontWeight: tab === k ? 600 : 400,
                }}
              >
                {k === "today" ? t("calendar.today") : t("calendar.week")}
              </button>
            ))}
          </div>

          {loading ? (
            <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{t("calendar.syncing")}</div>
          ) : events.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
              {tab === "today" ? t("calendar.noEventsToday") : t("calendar.noEventsWeek")}
            </div>
          ) : tab === "today" ? (
            events.map((ev) => <EventCard key={ev.id} event={ev} />)
          ) : (
            grouped.map((g) => (
              <div key={g.day} style={{ marginBottom: 18 }}>
                <div style={{
                  fontSize: 12, fontWeight: 600, color: "var(--text-muted)",
                  textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8,
                }}>
                  {g.day}
                </div>
                {g.items.map((ev) => <EventCard key={ev.id} event={ev} />)}
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
