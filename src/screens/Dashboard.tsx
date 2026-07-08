import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useCalendarStore } from "../store/calendarStore";
import { useChatStore } from "../store/chatStore";
import { useRecordingStore, useRecordingElapsed } from "../store/recordingStore";
import { useNotesStore } from "../store/notesStore";
import { useTourTarget } from "../store/tourStore";
import BookingDemo from "../components/BookingDemo";
import BriefingTask from "../components/BriefingTask";
import BriefingContent from "../components/BriefingContent";
import type { CalendarEvent } from "../bindings/CalendarEvent";
import type { NoteFile } from "../bindings/NoteFile";
import type { NoteMetadata } from "../bindings/NoteMetadata";
import { toggleChecked, groupTasksBySection, type TaskLine } from "../utils/todoTasks";

// ─── Hero card — enregistrement ───────────────────────────────────────────────

function HeroCard() {
  const { status, startRecording, stopRecording } = useRecordingStore();
  // Guided tour (spec/13) spotlights this exact card as "cliquez ici pour démarrer".
  const tourRef = useTourTarget("hero-card");

  // Elapsed time is derived from the recording's start timestamp (see store), so
  // it stays accurate even after navigating away from the Dashboard and back.
  const elapsed = useRecordingElapsed();

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const isIdle = status === "idle";
  const isRecording = status === "recording";
  const isProcessing = status === "stopping" || status === "processing";

  return (
    <div
      ref={tourRef}
      onClick={isIdle ? () => startRecording() : undefined}
      style={{
        background: isRecording ? "#3D0A0A" : "var(--dark-card)",
        borderRadius: 16, padding: "20px 28px",
        display: "flex", alignItems: "center", gap: 20,
        cursor: isIdle ? "pointer" : "default",
        transition: "background 0.3s",
      }}
    >
      {/* Icon */}
      <div style={{
        width: 52, height: 52, borderRadius: "50%",
        border: `2px solid ${isRecording ? "#E05050" : "var(--accent)"}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0,
      }}>
        {isProcessing ? (
          <span style={{ fontSize: 22 }}>⏳</span>
        ) : isRecording ? (
          <span style={{ fontSize: 22, color: "#E05050" }}>●</span>
        ) : (
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round">
            <rect x="9" y="1" width="6" height="13" rx="3"/>
            <path d="M5 10a7 7 0 0 0 14 0"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
        )}
      </div>

      {/* Text */}
      <div style={{ flex: 1 }}>
        {isIdle && (
          <>
            <div style={{ fontSize: 18, fontWeight: 600, color: "var(--accent)", marginBottom: 4 }}>
              Prendre des notes maintenant
            </div>
            <div style={{ fontSize: 13, color: "#9B9B9B" }}>
              Enregistre, transcrit et extrait les actions
            </div>
          </>
        )}
        {isRecording && (
          <>
            <div style={{ fontSize: 18, fontWeight: 600, color: "#E05050", marginBottom: 4 }}>
              Enregistrement en cours… {fmt(elapsed)}
            </div>
            <div style={{ fontSize: 13, color: "#9B9B9B" }}>
              Parlez naturellement — Alfred transcrit en temps réel
            </div>
          </>
        )}
        {isProcessing && (
          <div style={{ fontSize: 16, color: "#9B9B9B" }}>
            Transcription en cours…
          </div>
        )}
      </div>

      {/* Action */}
      {isIdle && (
        <span style={{ fontSize: 20, color: "#9B9B9B" }}>→</span>
      )}
      {isRecording && (
        <button
          onClick={e => { e.stopPropagation(); stopRecording(); }}
          style={{
            background: "#E05050", color: "#fff", border: "none",
            borderRadius: 8, padding: "8px 18px", cursor: "pointer",
            fontSize: 13, fontWeight: 500,
          }}
        >
          ⏹ Arrêter
        </button>
      )}
    </div>
  );
}

// ─── Section tâches — sections Prioritaire / En cours / À faire (spec/10) ──────
// Reads/writes Todo.md directly (same pattern as Tasks.tsx), grouped by the
// `## Section` headings the file already uses (spec/06) — a lighter, in-place
// summary rather than the full editor.

const DEFAULT_TODO_RELATIVE = "wiki/Todo.md";
const SECTIONS_SHOWN = ["Prioritaire", "En cours", "À faire"];
const SECTION_LIMIT = 5;

function TaskRow({ task, onToggle, onOpen }: {
  task: TaskLine; onToggle: () => void; onOpen: () => void;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "8px 0", borderBottom: "1px solid var(--border)",
    }}>
      <input
        type="checkbox"
        checked={task.checked}
        onChange={onToggle}
        style={{ width: 15, height: 15, cursor: "pointer", accentColor: "var(--accent)", flexShrink: 0 }}
      />
      <span
        onClick={onOpen}
        title="Ouvrir dans Tâches"
        style={{
          flex: 1, fontSize: 13.5, color: "var(--text-primary)", cursor: "pointer",
          textDecoration: task.checked ? "line-through" : "none",
          opacity: task.checked ? 0.5 : 1,
        }}
      >
        {renderInlineMd(task.text)}
      </span>
    </div>
  );
}

function TaskSectionBlock({ name, tasks, onToggle, onOpen }: {
  name: string; tasks: TaskLine[];
  onToggle: (taskIndex: number) => void; onOpen: () => void;
}) {
  if (tasks.length === 0) return null;
  const pending = tasks.filter(t => !t.checked).length;

  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0 4px" }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          {name}
        </span>
        {pending > 0 && <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{pending}</span>}
      </div>
      {tasks.slice(0, SECTION_LIMIT).map(t => (
        <TaskRow key={t.taskIndex} task={t} onToggle={() => onToggle(t.taskIndex)} onOpen={onOpen} />
      ))}
    </div>
  );
}

function TasksSection() {
  const navigate = useNavigate();
  const vaultPath = useNotesStore(s => s.vaultPath);
  const fetchVaultPath = useNotesStore(s => s.fetchVaultPath);
  const fetchRecents = useNotesStore(s => s.fetchRecents);
  const [collapsed, setCollapsed] = useState(false);

  const [rel, setRel] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const metaRef = useRef<NoteMetadata | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  const path = vaultPath && rel ? `${vaultPath}/${rel}` : null;

  useEffect(() => { fetchVaultPath(); }, [fetchVaultPath]);
  useEffect(() => {
    invoke<string>("get_todo_file")
      .then(r => setRel(r || DEFAULT_TODO_RELATIVE))
      .catch(() => setRel(DEFAULT_TODO_RELATIVE));
  }, []);

  const load = useCallback(async () => {
    if (!path) return;
    try {
      const file = await invoke<NoteFile>("get_note_file", { path });
      metaRef.current = file.metadata;
      setBody(file.body);
    } catch {
      metaRef.current = null;
      setBody("");
    }
  }, [path]);

  useEffect(() => {
    load();
    const unsubs: Array<() => void> = [];
    // notes-updated: file rewritten elsewhere. todos-updated: the merged
    // ingestion (spec/05) dual-writes SQLite + this file — either means "reload".
    listen("notes-updated", () => load()).then(fn => unsubs.push(fn));
    listen("todos-updated", () => load()).then(fn => unsubs.push(fn));
    return () => unsubs.forEach(fn => fn());
  }, [load]);

  const save = useCallback((newBody: string) => {
    if (!path || !metaRef.current) return;
    const meta = metaRef.current;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      invoke<NoteFile>("update_note_file", { path, metadata: meta, body: newBody })
        .then(() => fetchRecents())
        .catch(e => console.error("Tasks: save failed:", e));
    }, 600);
  }, [path, fetchRecents]);

  const apply = (newBody: string) => { setBody(newBody); save(newBody); };

  if (!path) return null;

  const groups = groupTasksBySection(body);
  const totalPending = SECTIONS_SHOWN.reduce(
    (n, s) => n + (groups.get(s) ?? []).filter(t => !t.checked).length, 0
  );

  return (
    <div className="card" style={{ padding: "20px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
          Vos tâches
        </h2>
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          {totalPending > 0 ? `${totalPending} en attente` : "tout est fait"}
        </span>
        <button
          onClick={() => setCollapsed(c => !c)}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 12 }}
        >
          {collapsed ? "Déplier ▾" : "Replier ▴"}
        </button>
        <button
          onClick={() => navigate("/tasks")}
          style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: 12.5, fontWeight: 500 }}
        >
          Voir toutes les tâches →
        </button>
      </div>

      {!collapsed && (
        totalPending === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "10px 0 2px" }}>
            Rien en attente — belle organisation.
          </div>
        ) : (
          SECTIONS_SHOWN.map(name => (
            <TaskSectionBlock
              key={name}
              name={name}
              tasks={groups.get(name) ?? []}
              onToggle={(taskIndex) => apply(toggleChecked(body, taskIndex))}
              onOpen={() => navigate("/tasks")}
            />
          ))
        )
      )}
    </div>
  );
}

// ─── Résumé IA ────────────────────────────────────────────────────────────────

// ─── Tableau de tâches IA parallèles ──────────────────────────────────────────

export type AITaskKind = "briefing" | "booking";

export interface AITask {
  id: string;
  kind: AITaskKind;
  event: CalendarEvent;
}

function TaskCard({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  // Bring the freshly launched task into view
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  return (
    <div ref={ref} className="card" style={{ padding: "20px 24px" }}>
      {children}
    </div>
  );
}

function TaskBoard({ tasks, onRemove }: { tasks: AITask[]; onRemove: (id: string) => void }) {
  if (tasks.length === 0) return null;

  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 10,
        fontSize: 13, fontWeight: 600, color: "var(--text-secondary)",
      }}>
        <span style={{ color: "var(--accent)" }}>✦</span>
        Tâches Alfred ({tasks.length})
      </div>
      <div style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}>
        {tasks.map(task => (
          <TaskCard key={task.id}>
            {task.kind === "booking" ? (
              <BookingDemo event={task.event} onClose={() => onRemove(task.id)} />
            ) : (
              <BriefingTask event={task.event} onClose={() => onRemove(task.id)} />
            )}
          </TaskCard>
        ))}
      </div>
    </div>
  );
}

// Render a short string with **bold** segments as React nodes (inline markdown only).
function renderInlineMd(text: string) {
  return text.split(/(\*\*.+?\*\*)/g).map((part, i) => {
    const m = /^\*\*(.+?)\*\*$/.exec(part);
    return m
      ? <strong key={i} style={{ fontWeight: 600, color: "var(--text-primary)" }}>{m[1]}</strong>
      : <span key={i}>{part}</span>;
  });
}

// ─── Brief quotidien — bloc « Aujourd'hui » (spec/05 usage 3, spec/10) ─────────

function BriefCard() {
  const [text, setText] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const openNoteByRef = useNotesStore(s => s.openNoteByRef);
  const navigate = useNavigate();

  const today = () => new Date().toISOString().slice(0, 10);

  const generate = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<string>("generate_daily_brief");
      setText(result);
      setGeneratedAt(today());
    } catch (e) {
      console.error("daily brief failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    invoke<{ text: string; generated_at: string } | null>("get_daily_brief").then(r => {
      if (r) {
        setText(r.text);
        setGeneratedAt(r.generated_at);
      }
      // Auto-generate once per day, on first load, if nothing cached for today.
      if (!r || r.generated_at !== today()) generate();
    }).catch(() => generate());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleWikilink = async (ref: string) => {
    const ok = await openNoteByRef(ref);
    if (ok) navigate("/notes");
  };

  return (
    <div className="card" style={{ padding: "20px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ color: "var(--accent)", fontSize: 16 }}>✦</span>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>Aujourd'hui</h2>
        <button
          onClick={generate}
          disabled={loading}
          style={{
            marginLeft: "auto", background: "none", border: "1px solid var(--border)",
            borderRadius: 6, padding: "3px 10px", cursor: loading ? "not-allowed" : "pointer",
            fontSize: 12, color: "var(--text-secondary)",
          }}
        >
          {loading ? "⏳" : "↻ Régénérer"}
        </button>
      </div>

      {loading && !text ? (
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Alfred prépare votre brief…</div>
      ) : text ? (
        <>
          <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
            <BriefingContent markdown={text} onWikilink={handleWikilink} />
          </div>
          {generatedAt && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>Généré le {generatedAt}</div>
          )}
        </>
      ) : (
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Enregistrez ou écrivez quelque chose, et Alfred vous préparera un point chaque jour.
        </div>
      )}
    </div>
  );
}

// ─── Input Alfred — teaser de chat (spec/10, historique complet dans /ai-actions) ─

const CHAT_EXAMPLES = [
  "Résume mes notes récentes",
  "Sur quoi ai-je travaillé cette semaine ?",
  "Quelles sont mes tâches en retard ?",
];

function ChatTeaser() {
  const [text, setText] = useState("");
  const navigate = useNavigate();
  const send = useChatStore(s => s.send);

  const submit = (question: string) => {
    const q = question.trim();
    if (!q) return;
    setText("");
    send(q);
    navigate("/ai-actions");
  };

  return (
    <div className="card" style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--accent)", fontSize: 16 }}>✦</span>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Demander à Alfred</h2>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(text); }}
          placeholder="Posez une question sur vos notes…"
          style={{
            flex: 1, border: "1px solid var(--border)", borderRadius: 8,
            padding: "8px 12px", fontSize: 13.5, background: "var(--bg)", color: "var(--text-primary)",
          }}
        />
        <button
          onClick={() => submit(text)}
          disabled={!text.trim()}
          style={{
            background: text.trim() ? "var(--accent)" : "var(--border)", color: "#fff", border: "none",
            borderRadius: 8, padding: "8px 16px", cursor: text.trim() ? "pointer" : "not-allowed",
            fontSize: 13, fontWeight: 500, whiteSpace: "nowrap",
          }}
        >
          Envoyer
        </button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {CHAT_EXAMPLES.map(ex => (
          <button
            key={ex}
            onClick={() => submit(ex)}
            style={{
              background: "var(--active-bg)", border: "1px solid var(--border)",
              borderRadius: 16, padding: "5px 12px", cursor: "pointer",
              fontSize: 12, color: "var(--text-secondary)",
            }}
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Panel droit — Cette semaine ──────────────────────────────────────────────

function groupEventsByDay(events: CalendarEvent[]) {
  const groups: Record<string, CalendarEvent[]> = {};
  for (const ev of events) {
    const day = ev.start_at.slice(0, 10);
    if (!groups[day]) groups[day] = [];
    groups[day].push(ev);
  }
  return groups;
}

function dayLabel(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const d = date.getDate();
  const months = ["jan", "fév", "mar", "avr", "mai", "juin", "juil", "août", "sep", "oct", "nov", "déc"];
  const m = months[date.getMonth()];

  if (date.toDateString() === today.toDateString()) return `Aujourd'hui – ${d} ${m}`;
  if (date.toDateString() === tomorrow.toDateString()) return `Demain – ${d} ${m}`;

  const days = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
  return `${days[date.getDay()]} – ${d} ${m}`;
}

function isOnline(event: CalendarEvent): boolean {
  const loc = (event.location ?? "").toLowerCase();
  return loc.includes("ligne") || loc.includes("online") || loc.includes("zoom") || loc.includes("teams") || loc.includes("meet") || loc.includes("visio");
}

const MEAL_KEYWORDS = ["déjeuner", "dejeuner", "dîner", "diner", "lunch", "dinner", "repas", "restaurant", "resto", "brunch"];

function isMeal(event: CalendarEvent): boolean {
  const t = event.title.toLowerCase();
  return MEAL_KEYWORDS.some(k => t.includes(k));
}

function formatTime(isoStr: string): string {
  try {
    return new Date(isoStr).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function WeekPanel({ onBrief, onBook }: {
  onBrief: (ev: CalendarEvent) => void;
  onBook: (ev: CalendarEvent) => void;
}) {
  const { weekEvents, fetchWeekEvents } = useCalendarStore();
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  useEffect(() => {
    fetchWeekEvents();
    let unsub: (() => void) | undefined;
    listen("calendar-synced", () => fetchWeekEvents()).then(fn => { unsub = fn; });
    return () => unsub?.();
  }, [fetchWeekEvents]);

  const groups = groupEventsByDay(weekEvents);
  const days = Object.keys(groups).sort();

  return (
    <aside style={{
      width: 280, minWidth: 280,
      borderLeft: "1px solid var(--border)",
      background: "var(--card-bg)",
      display: "flex", flexDirection: "column",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{ padding: "20px 20px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 16, fontWeight: 600, color: "var(--accent)" }}>Cette semaine</span>
        <span style={{ fontSize: 16, color: "var(--text-muted)" }}>📅</span>
      </div>

      {/* Events */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 20px" }}>
        {days.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center", paddingTop: 24 }}>
            Aucun événement cette semaine
          </div>
        ) : (
          days.map(day => (
            <div key={day} style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 10 }}>
                {dayLabel(day)}
              </div>
              {groups[day].map(ev => {
                const selected = selectedEventId === ev.id;
                return (
                  <div
                    key={ev.id}
                    onClick={() => setSelectedEventId(selected ? null : ev.id)}
                    style={{
                      display: "flex", gap: 12, marginBottom: 12, alignItems: "flex-start",
                      cursor: "pointer", borderRadius: 8, padding: "4px 6px", margin: "0 -6px 8px",
                      background: selected ? "var(--hover-bg, rgba(128,128,128,0.08))" : "transparent",
                      transition: "background 0.15s",
                    }}
                  >
                    <span style={{
                      width: 8, height: 8, borderRadius: "50%", marginTop: 5, flexShrink: 0,
                      background: isOnline(ev) ? "var(--dot-purple)" : "var(--dot-orange)",
                    }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 2 }}>
                        {formatTime(ev.start_at)}
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", lineHeight: 1.3 }}>
                        {ev.title}
                      </div>
                      {ev.location && (
                        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 1 }}>
                          {ev.location}
                        </div>
                      )}
                      {selected && (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 5, marginTop: 6 }}>
                          <button
                            onClick={e => { e.stopPropagation(); onBrief(ev); }}
                            style={{
                              background: "none",
                              border: "1px solid var(--accent)", borderRadius: 6,
                              padding: "3px 10px", cursor: "pointer",
                              fontSize: 12, fontWeight: 500, color: "var(--accent)",
                              display: "inline-flex", alignItems: "center", gap: 5,
                            }}
                          >
                            ✦ Résumé des notes
                          </button>
                          {isMeal(ev) && (
                            <button
                              onClick={e => { e.stopPropagation(); onBook(ev); }}
                              style={{
                                background: "var(--accent)", color: "#fff",
                                border: "none", borderRadius: 6,
                                padding: "4px 10px", cursor: "pointer",
                                fontSize: 12, fontWeight: 500,
                                display: "inline-flex", alignItems: "center", gap: 5,
                              }}
                            >
                              📞 Demander à Alfred de réserver
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border)" }}>
        <button style={{
          background: "none", border: "none", cursor: "pointer",
          color: "var(--accent)", fontSize: 13, fontWeight: 500,
          display: "flex", alignItems: "center", gap: 6, padding: 0,
        }}>
          Afficher le calendrier complet →
        </button>
      </div>

    </aside>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { fetchTodayEvents } = useCalendarStore();
  const [tasks, setTasks] = useState<AITask[]>([]);

  useEffect(() => {
    fetchTodayEvents();
    // Re-fetch when a sync lands — the initial fetch above races the backend's
    // startup sync, and the 15-min periodic sync brings in later changes too.
    let unsub: (() => void) | undefined;
    listen("calendar-synced", () => fetchTodayEvents()).then(fn => { unsub = fn; });
    return () => unsub?.();
  }, [fetchTodayEvents]);

  const addTask = (kind: AITaskKind, event: CalendarEvent) => {
    setTasks(prev =>
      prev.some(t => t.kind === kind && t.event.id === event.id)
        ? prev // already running for this event — keep it
        : [{ id: `${kind}-${event.id}`, kind, event }, ...prev] // newest on top
    );
  };

  const removeTask = (id: string) => setTasks(prev => prev.filter(t => t.id !== id));

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* Main content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px", display: "flex", flexDirection: "column", gap: 20 }}>
        <BriefCard />
        <HeroCard />
        <TasksSection />
        <TaskBoard tasks={tasks} onRemove={removeTask} />
        <ChatTeaser />
      </div>

      {/* Right panel */}
      <WeekPanel
        onBrief={ev => addTask("briefing", ev)}
        onBook={ev => addTask("booking", ev)}
      />
    </div>
  );
}
