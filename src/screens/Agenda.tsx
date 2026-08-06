import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MdLocationOn, MdPeople, MdCheckBox } from "react-icons/md";
import type { CalendarEvent } from "../bindings/CalendarEvent";
import type { GoogleAuthStatus } from "../bindings/GoogleAuthStatus";
import type { Todo } from "../bindings/Todo";
import { useT } from "../i18n";

// Écran Agenda (spec/02 §3a) — Google Calendar, lecture seule. Aucune
// création/modification d'événement depuis Alfred (hors scope explicite).
//
// Les échéances de tâches (`Todo.md`, spec/06) sont mêlées aux événements
// (spec/02 §3a, ajout post-implémentation) : même notion de "chose à ce
// moment-là", simple assemblage à l'affichage — aucune écriture croisée entre
// les deux sources. Toujours affichées, même sans Google Calendar connecté
// (Todo.md ne dépend pas du calendrier).

/** Clé de jour locale (YYYY-MM-DD) — comparable entre un ISO de Google
 *  Calendar (avec fuseau) et une `echeance` de tâche (date nue, sans heure). */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** `echeance` ("YYYY-MM-DD") → Date locale à minuit — `T00:00:00` (sans `Z`)
 *  force une interprétation locale plutôt qu'UTC (sinon décalage d'un jour
 *  possible selon le fuseau, même piège que `Tasks.tsx` `dueKind`). */
function todoDate(echeance: string): Date {
  return new Date(`${echeance}T00:00:00`);
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}h${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatDay(d: Date): string {
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

function TaskDeadlineCard({ todo, onClick }: { todo: Todo; onClick: () => void }) {
  const t = useT();
  return (
    <div
      onClick={onClick}
      style={{
        padding: "12px 16px", borderRadius: 10, border: "1px solid var(--border)",
        background: "var(--card-bg)", marginBottom: 8, cursor: "pointer",
        display: "flex", alignItems: "baseline", gap: 10,
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)", flexShrink: 0, minWidth: 56, display: "flex", alignItems: "center", gap: 4 }}>
        <MdCheckBox size={14} /> {t("calendar.deadline")}
      </span>
      <span style={{ fontSize: 14, color: "var(--text-primary)", fontWeight: 500 }}>{todo.title}</span>
    </div>
  );
}

type AgendaGroup = { key: string; day: Date; events: CalendarEvent[]; todos: Todo[] };

export default function Agenda() {
  const t = useT();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"today" | "week">("today");
  const [connected, setConnected] = useState<boolean | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async (period: "today" | "week") => {
    setLoading(true);
    try {
      const [evs, allTodos] = await Promise.all([
        invoke<CalendarEvent[]>(period === "today" ? "get_today_events" : "get_week_events").catch(() => []),
        invoke<Todo[]>("get_todos").catch(() => []),
      ]);
      setEvents(evs);

      const today = new Date();
      const todayKey = localDayKey(today);
      const horizon = new Date(today);
      horizon.setDate(horizon.getDate() + 6);
      const horizonKey = localDayKey(horizon);
      setTodos(
        allTodos.filter((td) => {
          if (!td.echeance) return false;
          const key = localDayKey(todoDate(td.echeance));
          return period === "today" ? key === todayKey : key >= todayKey && key <= horizonKey;
        })
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    invoke<GoogleAuthStatus>("get_calendar_auth_status")
      .then((s) => setConnected(s.connected))
      .catch(() => setConnected(false));
  }, []);

  useEffect(() => { fetchAll(tab); }, [tab, fetchAll]);

  useEffect(() => {
    const unsubs: (() => void)[] = [];
    listen("calendar-synced", () => fetchAll(tab)).then((fn) => unsubs.push(fn));
    listen("todos-updated", () => fetchAll(tab)).then((fn) => unsubs.push(fn));
    return () => unsubs.forEach((fn) => fn());
  }, [tab, fetchAll]);

  // Regroupe événements + échéances par jour de DÉBUT (spec/02 §3a) — les
  // échéances (pas d'heure) passent en tête de leur journée, avant les
  // événements datés. Vue semaine uniquement : la vue jour ne groupe pas (déjà
  // filtrée à aujourd'hui côté back/front) — un événement multi-jours démarré
  // hier grouperait sinon sous "hier" et disparaîtrait de l'onglet "jour".
  const groups: AgendaGroup[] = [];
  const groupFor = (d: Date) => {
    const key = localDayKey(d);
    let g = groups.find((g) => g.key === key);
    if (!g) {
      g = { key, day: d, events: [], todos: [] };
      groups.push(g);
    }
    return g;
  };
  if (tab === "week") {
    for (const td of todos) groupFor(todoDate(td.echeance!)).todos.push(td);
    for (const ev of events) groupFor(new Date(ev.start_at)).events.push(ev);
    groups.sort((a, b) => a.key.localeCompare(b.key));
  }

  const isEmpty = tab === "today" ? todos.length === 0 && events.length === 0 : groups.length === 0;

  return (
    <div style={{ padding: 32, maxWidth: 720, overflowY: "auto", height: "100%" }}>
      <h1 style={{ margin: "0 0 20px", fontSize: 22, fontWeight: 600, color: "var(--text-primary)" }}>
        {t("calendar.title")}
      </h1>

      {connected === false && (
        <div style={{
          padding: "10px 14px", borderRadius: 8, border: "1px solid var(--border)",
          background: "var(--card-bg)", color: "var(--text-secondary)", fontSize: 12.5,
          marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
        }}>
          <span>{t("calendar.notConnected")}</span>
          <button
            onClick={() => navigate("/settings")}
            style={{
              background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6,
              padding: "5px 10px", cursor: "pointer", fontSize: 12, flexShrink: 0,
            }}
          >
            {t("calendar.goToSettings")}
          </button>
        </div>
      )}

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
      ) : isEmpty ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
          {tab === "today" ? t("calendar.noEventsToday") : t("calendar.noEventsWeek")}
        </div>
      ) : tab === "today" ? (
        <>
          {todos.map((td) => <TaskDeadlineCard key={td.id} todo={td} onClick={() => navigate("/tasks")} />)}
          {events.map((ev) => <EventCard key={ev.id} event={ev} />)}
        </>
      ) : (
        groups.map((g) => (
          <div key={g.key} style={{ marginBottom: 18 }}>
            <div style={{
              fontSize: 12, fontWeight: 600, color: "var(--text-muted)",
              textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8,
            }}>
              {formatDay(g.day)}
            </div>
            {g.todos.map((td) => <TaskDeadlineCard key={td.id} todo={td} onClick={() => navigate("/tasks")} />)}
            {g.events.map((ev) => <EventCard key={ev.id} event={ev} />)}
          </div>
        ))
      )}
    </div>
  );
}
