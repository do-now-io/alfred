import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { MdUploadFile } from "react-icons/md";
import { useRecordingStore, useRecordingElapsed } from "../store/recordingStore";
import { useNotesStore } from "../store/notesStore";
import { useTourTarget } from "../store/tourStore";
import BriefingContent from "../components/BriefingContent";
import ChatPanel from "../components/chat/ChatPanel";
import type { NoteFile } from "../bindings/NoteFile";
import type { NoteMetadata } from "../bindings/NoteMetadata";
import { toggleChecked, groupTasksBySection, type TaskLine } from "../utils/todoTasks";
import { renderInlineMd } from "../utils/inlineMd";
import { useInternalLink } from "../utils/useInternalLink";
import { useI18nStore, useT } from "../i18n";
import { TODO_SECTION_LABELS, type TodoSectionKey } from "../i18n/todoSections";

// ─── Hero card — enregistrement ───────────────────────────────────────────────

function HeroCard() {
  const t = useT();
  const navigate = useNavigate();
  const { status, startRecording, stopRecording, importAudioFile } = useRecordingStore();
  // Guided tour (spec/13) spotlights this exact card as "cliquez ici pour démarrer".
  const tourRef = useTourTarget("hero-card");

  // Elapsed time is derived from the recording's start timestamp (see store), so
  // it stays accurate even after navigating away from the Dashboard and back.
  const elapsed = useRecordingElapsed();

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const isIdle = status === "idle";
  const isRecording = status === "recording" || status === "paused";
  // Cette carte ne lance que des prises "meeting" (spec/03) : stop_recording les
  // envoie directement en traitement, "stopped" (revue) ne s'y produit jamais.
  const isProcessing = status === "stopping" || status === "processing";

  // Same trigger + destination as the sidebar logo (spec/03): start, then hand
  // off to the guidance page for live feedback + capture tips.
  const handleStart = () => {
    startRecording();
    navigate("/recording");
  };

  return (
    <div
      ref={tourRef}
      onClick={isIdle ? handleStart : undefined}
      style={{
        position: "relative",
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
              {t("dashboard.heroCard.takeNotesNow")}
            </div>
            <div style={{ fontSize: 13, color: "#9B9B9B" }}>
              {t("dashboard.heroCard.idleSubtitle")}
            </div>
          </>
        )}
        {isRecording && (
          <>
            <div style={{ fontSize: 18, fontWeight: 600, color: "#E05050", marginBottom: 4 }}>
              {t("dashboard.heroCard.recording", { time: fmt(elapsed) })}
            </div>
            <div style={{ fontSize: 13, color: "#9B9B9B" }}>
              {t("dashboard.heroCard.recordingSubtitle")}
            </div>
          </>
        )}
        {isProcessing && (
          <div style={{ fontSize: 16, color: "#9B9B9B" }}>
            {t("dashboard.heroCard.transcribing")}
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
          ⏹ {t("dashboard.heroCard.stop")}
        </button>
      )}
      {/* Import d'un fichier audio existant (spec/03) — incorporé à la carte
          plutôt qu'un bouton séparé sous celle-ci ; visible seulement au repos. */}
      {isIdle && (
        <button
          onClick={(e) => { e.stopPropagation(); importAudioFile(); }}
          title={t("dashboard.heroCard.importAudio")}
          style={{
            position: "absolute", top: 10, right: 10, width: 32, height: 32, borderRadius: "50%",
            background: "rgba(255,255,255,0.08)", border: "1px solid var(--border)", color: "#9B9B9B",
            display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0,
          }}
        >
          <MdUploadFile size={16} />
        </button>
      )}
    </div>
  );
}

// ─── Section tâches — sections À faire / En cours (spec/06 v2/10) ──────────────
// Reads/writes Todo.md directly (same pattern as Tasks.tsx), grouped by the
// `## Section` headings the file already uses (spec/06) — a lighter, in-place
// summary rather than the full editor.

const DEFAULT_TODO_RELATIVE = "wiki/Todo.md";
// Clés stables (spec/21) — reconnues en FR et EN par `groupTasksBySection`,
// affichées via `TODO_SECTION_LABELS[lang]`.
const SECTIONS_SHOWN: TodoSectionKey[] = ["todo", "in_progress"];
const SECTION_LIMIT = 5;

function TaskRow({ task, onToggle, onOpen }: {
  task: TaskLine; onToggle: () => void; onOpen: () => void;
}) {
  const t = useT();
  const handleLink = useInternalLink();
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
        title={t("dashboard.tasksSection.openInTasks")}
        style={{
          flex: 1, fontSize: 13.5, color: "var(--text-primary)", cursor: "pointer",
          textDecoration: task.checked ? "line-through" : "none",
          opacity: task.checked ? 0.5 : 1,
        }}
      >
        {renderInlineMd(task.text, handleLink)}
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
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
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
          {t("dashboard.tasksSection.yourTasks")}
        </h2>
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          {totalPending > 0 ? t("dashboard.tasksSection.pending", { count: totalPending }) : t("dashboard.tasksSection.allDone")}
        </span>
        <button
          onClick={() => setCollapsed(c => !c)}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 12 }}
        >
          {collapsed ? t("dashboard.tasksSection.expand") : t("dashboard.tasksSection.collapse")}
        </button>
        <button
          onClick={() => navigate("/tasks")}
          style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: 12.5, fontWeight: 500 }}
        >
          {t("dashboard.tasksSection.seeAllTasks")}
        </button>
      </div>

      {!collapsed && (
        totalPending === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "10px 0 2px" }}>
            {t("dashboard.tasksSection.nothingPending")}
          </div>
        ) : (
          SECTIONS_SHOWN.map(key => (
            <TaskSectionBlock
              key={key}
              name={TODO_SECTION_LABELS[lang][key]}
              tasks={groups.get(key) ?? []}
              onToggle={(taskIndex) => apply(toggleChecked(body, taskIndex))}
              onOpen={() => navigate("/tasks")}
            />
          ))
        )
      )}
    </div>
  );
}

// ─── Brief quotidien — bloc « Aujourd'hui » (spec/05 usage 3, spec/10) ─────────

function BriefCard() {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const handleLink = useInternalLink();

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

  return (
    <div className="card" style={{ padding: "20px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ color: "var(--accent)", fontSize: 16 }}>✦</span>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>{t("dashboard.briefCard.today")}</h2>
        <button
          onClick={generate}
          disabled={loading}
          style={{
            marginLeft: "auto", background: "none", border: "1px solid var(--border)",
            borderRadius: 6, padding: "3px 10px", cursor: loading ? "not-allowed" : "pointer",
            fontSize: 12, color: "var(--text-secondary)",
          }}
        >
          {loading ? "⏳" : t("dashboard.briefCard.regenerate")}
        </button>
      </div>

      {loading && !text ? (
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{t("dashboard.briefCard.preparing")}</div>
      ) : text ? (
        <>
          <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
            <BriefingContent markdown={text} onNavigate={handleLink} />
          </div>
          {generatedAt && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>{t("dashboard.briefCard.generatedOn", { date: generatedAt })}</div>
          )}
        </>
      ) : (
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
          {t("dashboard.briefCard.empty")}
        </div>
      )}
    </div>
  );
}

// ─── Bandeau « données de démo » — one-shot (spec/13/10) ───────────────────────
// Visible tant que du contenu de démarrage marqué subsiste (vérifié en direct
// côté backend, pas un simple drapeau) ; disparaît définitivement après clic —
// ou tout seul si l'utilisateur a déjà tout supprimé à la main.

function DemoContentBanner() {
  const t = useT();
  const [present, setPresent] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const check = useCallback(() => {
    invoke<boolean>("has_starter_content").then(setPresent).catch(() => setPresent(false));
  }, []);

  useEffect(() => {
    check();
    const unsubs: Array<() => void> = [];
    listen("notes-updated", () => check()).then(fn => unsubs.push(fn));
    listen("todos-updated", () => check()).then(fn => unsubs.push(fn));
    return () => unsubs.forEach(fn => fn());
  }, [check]);

  if (!present) return null;

  const handleDelete = () => {
    setDeleting(true);
    invoke("delete_starter_content")
      .then(() => setPresent(false))
      .catch(() => setDeleting(false));
  };

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "8px 24px", borderBottom: "1px solid var(--border)",
      background: "var(--dark-card)", fontSize: 12.5, color: "var(--text-muted)",
    }}>
      <span>{t("dashboard.demoBanner.message")}</span>
      <button
        onClick={handleDelete}
        disabled={deleting}
        style={{
          marginLeft: "auto", background: "none", border: "1px solid var(--border)",
          borderRadius: 6, padding: "3px 10px", cursor: deleting ? "not-allowed" : "pointer",
          fontSize: 12, color: "var(--text-secondary)",
        }}
      >
        {deleting ? t("dashboard.demoBanner.deleting") : t("dashboard.demoBanner.delete")}
      </button>
    </div>
  );
}

// ─── Dashboard — fusion Alfred/Aujourd'hui, layout 2 colonnes (spec/10 cible) ──
// Gauche : conversation Alfred (ChatPanel, avec son propre historique) — la
// route `/ai-actions` disparaît, la page "/" EST la conversation. Droite :
// prise de note & résumé (carte d'enregistrement, brief, tâches), en lecture
// pendant qu'on discute avec Alfred dans l'autre colonne.

export default function Dashboard() {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <DemoContentBanner />
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: "1.3 1 0%", minWidth: 0, borderRight: "1px solid var(--border)", overflow: "hidden" }}>
          <ChatPanel />
        </div>
        <div style={{ flex: "1 1 0%", minWidth: 340, maxWidth: 480, overflowY: "auto" }}>
          <div style={{ padding: "24px 24px 28px", display: "flex", flexDirection: "column", gap: 20 }}>
            <HeroCard />
            <BriefCard />
            <TasksSection />
          </div>
        </div>
      </div>
    </div>
  );
}
