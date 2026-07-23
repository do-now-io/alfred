import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { MdCheck, MdClose, MdVolumeUp, MdPause, MdReplay, MdAutoFixHigh, MdPersonOutline, MdHelpOutline, MdLightbulbOutline } from "react-icons/md";
import { useResolveStore } from "../store/resolveStore";
import { useTourStore } from "../store/tourStore";
import type { NoteFile } from "../bindings/NoteFile";
import NoteEditor from "../components/notes/NoteEditor";
import { useT } from "../i18n";

// Écran de vérification (spec/17 §3, feedback tests) : **toujours** présenté
// après une transcription — réunion (spec/05) ou contexte à la voix (spec/13
// étape 5) — avant que quoi que ce soit ne soit écrit. UN SEUL écran pour les
// deux cas (« même composant, même route, mêmes interactions » — spec/13) :
// seul le contenu injecté diffère. Sans propositions (mode contexte, ou réunion
// sans rien à signaler), l'écran est juste plus court : texte + Valider.

type ItemStatus = "pending" | "applied" | "skipped";

/** Replace the first occurrence of `needle` (case-insensitive fallback). */
function replaceOnce(text: string, needle: string, replacement: string): { text: string; applied: boolean } {
  if (!needle) return { text, applied: false };
  const i = text.indexOf(needle);
  if (i >= 0) return { text: text.slice(0, i) + replacement + text.slice(i + needle.length), applied: true };
  const j = text.toLowerCase().indexOf(needle.toLowerCase());
  if (j >= 0) return { text: text.slice(0, j) + replacement + text.slice(j + needle.length), applied: true };
  return { text, applied: false };
}

/** Lazily load the recording's WAV once (by `recordingId` — spec/17 §3,
 *  feedback tests: a title-based lookup broke as soon as the raw note got
 *  archived/wasn't the note open) and play arbitrary [start, end] windows.
 *  Tracks which window is currently active so its own button (and only that
 *  one) can show Pause + a restart control (feedback tests — the audio used
 *  to just play through with no way to stop it). */
function useSegmentPlayer(recordingId: string) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const stopAtRef = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Identifies which button's window is loaded (its `start`) — `null` once
  // paused/ended, so no button shows the active Pause/restart state.
  const [activeStart, setActiveStart] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const buf = await invoke<ArrayBuffer>("read_recording_wav", { recordingId });
        if (cancelled) return;
        const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
        urlRef.current = url;
        const audio = new Audio(url);
        audio.addEventListener("timeupdate", () => {
          if (stopAtRef.current != null && audio.currentTime >= stopAtRef.current) {
            audio.pause();
            stopAtRef.current = null;
          }
        });
        audio.addEventListener("pause", () => setPlaying(false));
        audio.addEventListener("play", () => setPlaying(true));
        audio.addEventListener("ended", () => setActiveStart(null));
        audioRef.current = audio;
        setReady(true);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [recordingId]);

  const play = useCallback((start: number, end: number | null) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = Math.max(0, start - 0.15); // tiny lead-in
    stopAtRef.current = end;
    setActiveStart(start);
    audio.play().catch(() => {});
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  return { play, pause, playing, activeStart, ready, error };
}

const card: React.CSSProperties = {
  background: "var(--card-bg)", border: "1px solid var(--border)",
  borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8,
};
const actionBtn = (primary?: boolean): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: 4,
  border: `1px solid ${primary ? "var(--accent)" : "var(--border)"}`,
  background: primary ? "var(--accent)" : "transparent",
  color: primary ? "#fff" : "var(--text-secondary)",
  borderRadius: 8, padding: "5px 10px", fontSize: 12.5, cursor: "pointer",
});
const smallInput: React.CSSProperties = {
  border: "1px solid var(--border)", borderRadius: 8, padding: "6px 9px",
  fontSize: 13, background: "var(--bg)", color: "var(--text-primary)", width: "100%",
};

function GroupLabel({ icon, label, count }: { icon: React.ReactNode; label: string; count: number }) {
  if (count === 0) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: "var(--text-muted)", textTransform: "uppercase" }}>
      <span style={{ fontSize: 15, display: "flex" }}>{icon}</span>
      {label}
      <span style={{ color: "var(--text-muted)" }}>· {count}</span>
    </div>
  );
}

/** One "🔊 réécouter" button — becomes Pause + a circular "start over" button
 *  while ITS window is the one playing (feedback tests: previously the audio
 *  just played through to the end with no way to stop it). `isActive` decides
 *  which of the (possibly several) replay buttons on screen this is. */
function ReplayButton({
  start, end, play, pause, ready, playing, isActive, label,
}: {
  start: number | null; end: number | null;
  play: (s: number, e: number | null) => void;
  pause: () => void;
  ready: boolean; playing: boolean; isActive: boolean;
  /** Override the idle label — e.g. "Play from the start" for the header button. */
  label?: string;
}) {
  const t = useT();
  if (start == null) return null;
  const showPause = isActive && playing;
  return (
    <div style={{ display: "inline-flex", gap: 4 }}>
      <button
        onClick={() => (showPause ? pause() : play(start, end))}
        disabled={!ready}
        title={showPause ? t("resolve.replay.pauseTitle") : t("resolve.replay.title")}
        style={{ ...actionBtn(), opacity: ready ? 1 : 0.5, padding: "5px 8px" }}
      >
        {showPause ? <MdPause /> : <MdVolumeUp />} {showPause ? t("resolve.replay.pauseButton") : (label ?? t("resolve.replay.button"))}
      </button>
      {showPause && (
        <button
          onClick={() => play(start, end)}
          title={t("resolve.replay.restartTitle")}
          style={{ ...actionBtn(), padding: "5px 8px" }}
        >
          <MdReplay />
        </button>
      )}
    </div>
  );
}

function ResolvedRow({ label, onUndo }: { label: string; onUndo: () => void }) {
  const t = useT();
  return (
    <div style={{ ...card, flexDirection: "row", alignItems: "center", justifyContent: "space-between", background: "var(--bg)", opacity: 0.85 }}>
      <span style={{ fontSize: 12.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <button onClick={onUndo} style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, flexShrink: 0 }}>{t("resolve.resolvedRow.undo")}</button>
    </div>
  );
}

export default function Resolve() {
  const t = useT();
  const session = useResolveStore((s) => s.session);
  const navigate = useNavigate();
  const clear = useResolveStore((s) => s.clear);

  const [text, setText] = useState(session?.text ?? "");
  const { play, pause, playing, activeStart, ready } = useSegmentPlayer(session?.recordingId ?? "");
  const isContext = session?.mode === "context";

  const fixes = session?.clarifications.transcription_fixes ?? [];
  const unclear = session?.clarifications.unclear_sentences ?? [];
  const tasks = session?.clarifications.unassigned_tasks ?? [];
  const contextAdds = session?.clarifications.context_additions ?? [];

  // Per-item working state (keyed by index within its group).
  const [fixStatus, setFixStatus] = useState<Record<number, ItemStatus>>({});
  const [fixEdit, setFixEdit] = useState<Record<number, string>>({});
  const [unclearStatus, setUnclearStatus] = useState<Record<number, ItemStatus>>({});
  const [unclearEdit, setUnclearEdit] = useState<Record<number, string>>({});
  const [taskStatus, setTaskStatus] = useState<Record<number, ItemStatus>>({});
  const [taskOwner, setTaskOwner] = useState<Record<number, string>>({});
  const [adds, setAdds] = useState(() => contextAdds.map((c) => ({ fact: c.fact, accepted: true })));

  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep local state in sync if a new session arrives.
  useEffect(() => {
    setText(session?.text ?? "");
    setAdds((session?.clarifications.context_additions ?? []).map((c) => ({ fact: c.fact, accepted: true })));
    setFixStatus({}); setFixEdit({}); setUnclearStatus({}); setUnclearEdit({}); setTaskStatus({}); setTaskOwner({});
  }, [session?.recordingId]);

  const pending = useMemo(() => {
    const p = (n: number, st: Record<number, ItemStatus>) =>
      Array.from({ length: n }).filter((_, i) => (st[i] ?? "pending") === "pending").length;
    return p(fixes.length, fixStatus) + p(unclear.length, unclearStatus) + p(tasks.length, taskStatus);
  }, [fixes.length, unclear.length, tasks.length, fixStatus, unclearStatus, taskStatus]);

  if (!session) {
    return (
      <div style={{ padding: 48, textAlign: "center", color: "var(--text-secondary)" }}>
        <p style={{ fontSize: 15 }}>{t("resolve.empty.text")}</p>
        <button onClick={() => navigate("/")} style={{ ...actionBtn(true), marginTop: 12 }}>{t("resolve.empty.back")}</button>
      </div>
    );
  }

  const applyFix = (i: number, fix: (typeof fixes)[number]) => {
    const correction = (fixEdit[i] ?? fix.correction).trim();
    const { text: next } = replaceOnce(text, fix.quote, correction);
    setText(next);
    setFixStatus((s) => ({ ...s, [i]: "applied" }));
  };
  const replaceUnclear = (i: number, u: (typeof unclear)[number]) => {
    const proposed = (unclearEdit[i] ?? u.proposed).trim();
    const { text: next } = replaceOnce(text, u.quote, proposed);
    setText(next);
    setUnclearStatus((s) => ({ ...s, [i]: "applied" }));
  };
  const assignTask = (i: number, taskItem: (typeof tasks)[number]) => {
    const owner = (taskOwner[i] ?? "").trim();
    if (owner) setText((prev) => `${prev.trimEnd()}\n\n${t("resolve.tasks.ownerLine", { task: taskItem.task, owner })}`);
    setTaskStatus((s) => ({ ...s, [i]: "applied" }));
  };

  const finalize = async () => {
    setFinalizing(true);
    setError(null);
    try {
      if (isContext) {
        // Mode contexte (spec/13 étape 5) : réécrit Contexte Alfred.md sur le
        // texte relu/corrigé — regénère aussi le glossaire (hook contexte de
        // update_note_file, spec/17 §4).
        const note = await invoke<NoteFile>("get_note_file", { path: session.contextPath });
        await invoke("update_note_file", { path: session.contextPath, metadata: note.metadata, body: text });
        invoke("track_event", { event: "resolve_finalized", props: { mode: "context" } }).catch(() => {});
        clear();
        // Dans la visite guidée → spotlight sur les vrais déclencheurs
        // d'enregistrement avant la carte de clôture (feedback tests, spec/13).
        const tour = useTourStore.getState();
        if (tour.active) {
          tour.goto("record-cta");
          navigate("/");
        } else {
          navigate("/notes");
        }
        return;
      }

      const contextAdditions = adds.filter((a) => a.accepted).map((a) => a.fact.trim()).filter(Boolean);
      await invoke("finalize_ingestion", {
        recordingId: session.recordingId,
        correctedText: text,
        noteTitle: session.noteTitle,
        contextAdditions,
        // Sélection du panneau de revue (spec/03/05) — honorée à la finalisation.
        summary: session.summary,
        tasks: session.tasks,
      });
      invoke("track_event", { event: "resolve_finalized", props: { mode: "meeting", pending } }).catch(() => {});
      clear();
      navigate("/notes");
    } catch (e) {
      setError(String(e));
      setFinalizing(false);
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: "20px 24px", gap: 16, boxSizing: "border-box" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 20, color: "var(--text-primary)" }}>
            {isContext ? t("resolve.header.titleContext") : t("resolve.header.titleMeeting")}
          </h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
            {isContext
              ? t("resolve.header.subtitleContext")
              : pending > 0
                ? t(pending > 1 ? "resolve.header.subtitlePendingPlural" : "resolve.header.subtitlePending", { count: pending })
                : t("resolve.header.subtitleClear")}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          {!isContext && (
            <button
              onClick={() => {
                invoke("track_event", { event: "resolve_deferred", props: { pending } }).catch(() => {});
                navigate("/notes");
              }}
              disabled={finalizing}
              style={actionBtn()}
              title={t("resolve.actions.laterTitle")}
            >
              {t("resolve.actions.later")}
            </button>
          )}
          <button onClick={finalize} disabled={finalizing} style={{ ...actionBtn(true), padding: "7px 16px", fontSize: 13.5, fontWeight: 600 }}>
            {finalizing ? t("resolve.actions.finalizing") : isContext ? t("resolve.actions.validate") : t("resolve.actions.finalize")}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: "8px 12px", borderRadius: 8, background: "var(--tag-red-bg)", color: "var(--tag-red-text)", fontSize: 13 }}>{error}</div>
      )}

      {/* Body: editable text | propositions */}
      <div style={{ flex: 1, display: "flex", gap: 20, minHeight: 0 }}>
        <div style={{ flex: 1.5, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 6 }}>
            {isContext ? t("resolve.editor.labelContext") : t("resolve.editor.labelMeeting")}
          </div>
          <div style={{ flex: 1, border: "1px solid var(--border)", borderRadius: 12, background: "var(--card-bg)", overflow: "hidden", padding: "8px 12px" }}>
            <NoteEditor body={text} noteKey={session.recordingId} onChange={setText} />
          </div>
        </div>

        <div style={{ width: 400, minWidth: 340, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingRight: 4 }}>
          {session.noteTitle && (
            <div style={{ ...card, gap: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: "var(--text-muted)", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}>
                <MdVolumeUp /> {isContext ? t("resolve.replay.sectionContext") : t("resolve.replay.sectionMeeting")}
              </div>
              <div style={{ alignSelf: "flex-start" }}>
                <ReplayButton
                  start={0} end={null} play={play} pause={pause} ready={ready} playing={playing}
                  isActive={activeStart === 0} label={t("resolve.replay.fromStart")}
                />
              </div>
            </div>
          )}

          {pending === 0 && adds.length === 0 && (
            <div style={{ ...card, alignItems: "center", color: "var(--text-secondary)", fontSize: 13 }}>
              {isContext ? t("resolve.emptyPropositionsContext") : t("resolve.emptyPropositionsMeeting")}
            </div>
          )}

          <GroupLabel icon={<MdAutoFixHigh />} label={t("resolve.fixes.group")} count={fixes.length} />
          {fixes.map((f, i) => {
            const status = fixStatus[i] ?? "pending";
            if (status === "applied") return <ResolvedRow key={`f${i}`} label={t("resolve.fixes.applied", { value: fixEdit[i] ?? f.correction })} onUndo={() => setFixStatus((s) => ({ ...s, [i]: "pending" }))} />;
            if (status === "skipped") return <ResolvedRow key={`f${i}`} label={t("resolve.fixes.skipped")} onUndo={() => setFixStatus((s) => ({ ...s, [i]: "pending" }))} />;
            return (
              <div key={`f${i}`} style={card}>
                <div style={{ fontSize: 12.5, color: "var(--text-muted)", textDecoration: "line-through" }}>{f.quote}</div>
                <input value={fixEdit[i] ?? f.correction} onChange={(e) => setFixEdit((s) => ({ ...s, [i]: e.target.value }))} style={smallInput} />
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <button onClick={() => applyFix(i, f)} style={actionBtn(true)}><MdCheck /> {t("resolve.fixes.apply")}</button>
                  <button onClick={() => setFixStatus((s) => ({ ...s, [i]: "skipped" }))} style={actionBtn()}><MdClose /> {t("resolve.fixes.ignore")}</button>
                  <ReplayButton start={f.start} end={f.end} play={play} pause={pause} ready={ready} playing={playing} isActive={activeStart === f.start} />
                  {f.confidence != null && (
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>{t("resolve.fixes.confidence", { value: Math.round(f.confidence * 100) })}</span>
                  )}
                </div>
              </div>
            );
          })}

          <GroupLabel icon={<MdHelpOutline />} label={t("resolve.unclear.group")} count={unclear.length} />
          {unclear.map((u, i) => {
            const status = unclearStatus[i] ?? "pending";
            if (status !== "pending") return <ResolvedRow key={`u${i}`} label={status === "applied" ? t("resolve.unclear.applied") : t("resolve.unclear.skipped")} onUndo={() => setUnclearStatus((s) => ({ ...s, [i]: "pending" }))} />;
            return (
              <div key={`u${i}`} style={card}>
                <div style={{ fontSize: 12.5, color: "var(--text-muted)", fontStyle: "italic" }}>« {u.quote} »</div>
                <input value={unclearEdit[i] ?? u.proposed} onChange={(e) => setUnclearEdit((s) => ({ ...s, [i]: e.target.value }))} style={smallInput} />
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <button onClick={() => replaceUnclear(i, u)} style={actionBtn(true)}><MdCheck /> {t("resolve.unclear.reformulate")}</button>
                  <button onClick={() => setUnclearStatus((s) => ({ ...s, [i]: "skipped" }))} style={actionBtn()}><MdClose /> {t("resolve.unclear.leave")}</button>
                  <ReplayButton start={u.start} end={u.end} play={play} pause={pause} ready={ready} playing={playing} isActive={activeStart === u.start} />
                </div>
              </div>
            );
          })}

          <GroupLabel icon={<MdPersonOutline />} label={t("resolve.tasks.group")} count={tasks.length} />
          {tasks.map((taskItem, i) => {
            const status = taskStatus[i] ?? "pending";
            if (status !== "pending") return <ResolvedRow key={`t${i}`} label={status === "applied" ? (taskOwner[i] ? t("resolve.tasks.appliedWithOwner", { owner: taskOwner[i] }) : t("resolve.tasks.appliedNoOwner")) : t("resolve.tasks.skipped")} onUndo={() => setTaskStatus((s) => ({ ...s, [i]: "pending" }))} />;
            return (
              <div key={`t${i}`} style={card}>
                <div style={{ fontSize: 13, color: "var(--text-primary)" }}>{taskItem.task}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{taskItem.question}</div>
                <input placeholder={t("resolve.tasks.ownerPlaceholder")} value={taskOwner[i] ?? ""} onChange={(e) => setTaskOwner((s) => ({ ...s, [i]: e.target.value }))} style={smallInput} />
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => assignTask(i, taskItem)} style={actionBtn(true)}><MdCheck /> {t("resolve.tasks.validate")}</button>
                  <button onClick={() => setTaskStatus((s) => ({ ...s, [i]: "skipped" }))} style={actionBtn()}><MdClose /> {t("resolve.tasks.ignore")}</button>
                </div>
              </div>
            );
          })}

          <GroupLabel icon={<MdLightbulbOutline />} label={t("resolve.contextAdds.group")} count={adds.length} />
          {adds.map((a, i) => (
            <div key={`a${i}`} style={{ ...card, flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={a.accepted} onChange={(e) => setAdds((prev) => prev.map((x, k) => (k === i ? { ...x, accepted: e.target.checked } : x)))} style={{ flexShrink: 0, accentColor: "var(--accent)" }} />
              <input value={a.fact} onChange={(e) => setAdds((prev) => prev.map((x, k) => (k === i ? { ...x, fact: e.target.value } : x)))} style={{ ...smallInput, opacity: a.accepted ? 1 : 0.5 }} />
            </div>
          ))}
          {adds.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "0 2px" }}>{t("resolve.contextAdds.hint")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
