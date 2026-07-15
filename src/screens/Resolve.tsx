import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { MdCheck, MdClose, MdVolumeUp, MdAutoFixHigh, MdPersonOutline, MdHelpOutline, MdLightbulbOutline } from "react-icons/md";
import { useResolveStore, type ResolveSession, type ContextResolveSession } from "../store/resolveStore";
import { useTourStore } from "../store/tourStore";
import type { NoteFile } from "../bindings/NoteFile";
import NoteEditor from "../components/notes/NoteEditor";

// Augmented-ingestion resolution screen (spec/17 §3): review Claude's grouped
// propositions, apply the ones you want (one click), tweak the corrected text
// freely like any note, then finalize. Nothing is auto-applied.
//
// MODE CONTEXTE (spec/13 étape 5) : le même écran sert à corriger le contexte
// créé à la voix — 4 sections éditables + réécoute du WAV + Valider.

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

/** Lazily load the recording's WAV once and play arbitrary [start, end] windows. */
function useSegmentPlayer(noteTitle: string) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const stopAtRef = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const buf = await invoke<ArrayBuffer>("read_recording_wav", { noteTitle });
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
  }, [noteTitle]);

  const play = useCallback((start: number, end: number | null) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = Math.max(0, start - 0.15); // tiny lead-in
    stopAtRef.current = end;
    audio.play().catch(() => {});
  }, []);

  return { play, ready, error };
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

function ReplayButton({ start, end, play, ready }: { start: number | null; end: number | null; play: (s: number, e: number | null) => void; ready: boolean }) {
  if (start == null) return null;
  return (
    <button
      onClick={() => play(start, end)}
      disabled={!ready}
      title="Réécouter ce passage"
      style={{ ...actionBtn(), opacity: ready ? 1 : 0.5, padding: "5px 8px" }}
    >
      <MdVolumeUp /> Réécouter
    </button>
  );
}

function ResolvedRow({ label, onUndo }: { label: string; onUndo: () => void }) {
  return (
    <div style={{ ...card, flexDirection: "row", alignItems: "center", justifyContent: "space-between", background: "var(--bg)", opacity: 0.85 }}>
      <span style={{ fontSize: 12.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <button onClick={onUndo} style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, flexShrink: 0 }}>Revenir</button>
    </div>
  );
}

// ─── Mode contexte (spec/13 étape 5) ─────────────────────────────────────────

const SECTION_DEFS: Array<{ key: keyof ContextResolveSession["sections"]; heading: string; label: string }> = [
  { key: "entreprise", heading: "Mon entreprise", label: "Mon entreprise" },
  { key: "equipe", heading: "Équipe (prénoms & rôles)", label: "Équipe (prénoms & rôles)" },
  { key: "vocabulaire", heading: "Vocabulaire maison & noms propres", label: "Vocabulaire & noms propres" },
  { key: "projets", heading: "Projets en cours", label: "Projets en cours" },
];

/** Parse le corps de `Contexte Alfred.md` en 4 sections éditables. */
export function parseContextSections(body: string): ContextResolveSession["sections"] {
  const sections = { entreprise: "", equipe: "", vocabulaire: "", projets: "" };
  let current: keyof typeof sections | null = null;
  const buf: Record<string, string[]> = {};
  for (const line of body.split("\n")) {
    const h = line.trim().match(/^##\s+(.*)$/);
    if (h) {
      const def = SECTION_DEFS.find((d) => d.heading === h[1].trim());
      current = def ? def.key : null;
      continue;
    }
    if (current) (buf[current] ??= []).push(line);
  }
  for (const def of SECTION_DEFS) {
    sections[def.key] = (buf[def.key] ?? []).join("\n").trim();
  }
  return sections;
}

/** Réécoute du WAV de la prise de contexte — lecture simple, pas de segments. */
function ContextAudio({ noteTitle }: { noteTitle: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    invoke<ArrayBuffer>("read_recording_wav", { noteTitle })
      .then((buf) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [noteTitle]);
  if (!url) return null;
  return <audio controls src={url} style={{ width: "100%", height: 36 }} />;
}

function ResolveContext({ session }: { session: ContextResolveSession }) {
  const navigate = useNavigate();
  const clear = useResolveStore((s) => s.clear);
  const [sections, setSections] = useState(session.sections);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validate = async () => {
    setSaving(true);
    setError(null);
    try {
      // Recompose le corps avec les mêmes titres que le template (spec/16), puis
      // réécrit la note via update_note_file — qui régénère aussi le glossaire
      // (hook contexte de update_note_file, spec/17 §4).
      const note = await invoke<NoteFile>("get_note_file", { path: session.contextPath });
      const body =
        "# Contexte Alfred\n\n" +
        SECTION_DEFS.map((d) => `## ${d.heading}\n\n${(sections[d.key] ?? "").trim()}\n`).join("\n");
      await invoke("update_note_file", { path: session.contextPath, metadata: note.metadata, body });
      clear();
      // Dans la visite guidée → carte de clôture « Vous êtes équipé » (spec/13).
      const tour = useTourStore.getState();
      if (tour.active) {
        tour.goto("closing");
        navigate("/");
      } else {
        navigate("/notes");
      }
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", display: "flex", justifyContent: "center", padding: "24px" }}>
      <div style={{ width: "100%", maxWidth: 680, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, color: "var(--text-primary)" }}>Vérifiez ce qu'Alfred a compris</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
            Voici votre contexte, structuré à partir de votre présentation. Corrigez librement — surtout
            l'orthographe des noms propres — puis validez.
          </p>
        </div>

        {session.noteTitle && (
          <div style={{ ...card, gap: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: "var(--text-muted)", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}>
              <MdVolumeUp /> Réécouter votre présentation
            </div>
            <ContextAudio noteTitle={session.noteTitle} />
          </div>
        )}

        {error && (
          <div style={{ padding: "8px 12px", borderRadius: 8, background: "var(--tag-red-bg)", color: "var(--tag-red-text)", fontSize: 13 }}>{error}</div>
        )}

        {SECTION_DEFS.map((d) => (
          <div key={d.key} style={card}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{d.label}</div>
            <textarea
              value={sections[d.key]}
              onChange={(e) => setSections((s) => ({ ...s, [d.key]: e.target.value }))}
              rows={Math.max(3, sections[d.key].split("\n").length + 1)}
              style={{
                ...smallInput,
                resize: "vertical", fontFamily: "inherit", lineHeight: 1.5, minHeight: 72,
              }}
            />
          </div>
        ))}

        <div style={{ display: "flex", justifyContent: "flex-end", paddingBottom: 24 }}>
          <button onClick={validate} disabled={saving} style={{ ...actionBtn(true), padding: "9px 22px", fontSize: 14, fontWeight: 600 }}>
            {saving ? "Enregistrement…" : "Valider"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Mode réunion (spec/17 §3) ────────────────────────────────────────────────

export default function Resolve() {
  const session = useResolveStore((s) => s.session);
  if (session?.mode === "context") return <ResolveContext session={session} />;
  return <ResolveMeeting session={session ?? null} />;
}

function ResolveMeeting({ session }: { session: ResolveSession | null }) {
  const navigate = useNavigate();
  const clear = useResolveStore((s) => s.clear);

  const [text, setText] = useState(session?.text ?? "");
  const { play, ready } = useSegmentPlayer(session?.noteTitle ?? "");

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

  // Keep local `adds` in sync if a new session arrives.
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
        <p style={{ fontSize: 15 }}>Rien à vérifier pour le moment.</p>
        <button onClick={() => navigate("/")} style={{ ...actionBtn(true), marginTop: 12 }}>Retour à l'accueil</button>
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
  const assignTask = (i: number, t: (typeof tasks)[number]) => {
    const owner = (taskOwner[i] ?? "").trim();
    if (owner) setText((prev) => `${prev.trimEnd()}\n\nResponsable de « ${t.task} » : ${owner}.`);
    setTaskStatus((s) => ({ ...s, [i]: "applied" }));
  };

  const finalize = async () => {
    setFinalizing(true);
    setError(null);
    try {
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
          <h1 style={{ margin: 0, fontSize: 20, color: "var(--text-primary)" }}>Vérification avant compte-rendu</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
            Alfred a repéré {pending} point{pending > 1 ? "s" : ""} à vérifier. Appliquez ce qui vous convient, corrigez le texte librement, puis finalisez.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          <button onClick={() => navigate("/notes")} disabled={finalizing} style={actionBtn()} title="Revenir plus tard — la vérification reste en attente">Plus tard</button>
          <button onClick={finalize} disabled={finalizing} style={{ ...actionBtn(true), padding: "7px 16px", fontSize: 13.5, fontWeight: 600 }}>
            {finalizing ? "Finalisation…" : "Finaliser le compte-rendu"}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: "8px 12px", borderRadius: 8, background: "var(--tag-red-bg)", color: "var(--tag-red-text)", fontSize: 13 }}>{error}</div>
      )}

      {/* Body: editable text | propositions */}
      <div style={{ flex: 1, display: "flex", gap: 20, minHeight: 0 }}>
        <div style={{ flex: 1.5, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 6 }}>Transcription corrigée</div>
          <div style={{ flex: 1, border: "1px solid var(--border)", borderRadius: 12, background: "var(--card-bg)", overflow: "hidden", padding: "8px 12px" }}>
            <NoteEditor body={text} noteKey={session.recordingId} onChange={setText} />
          </div>
        </div>

        <div style={{ width: 400, minWidth: 340, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingRight: 4 }}>
          {pending === 0 && adds.length === 0 && (
            <div style={{ ...card, alignItems: "center", color: "var(--text-secondary)", fontSize: 13 }}>Tout est traité. Vous pouvez finaliser.</div>
          )}

          <GroupLabel icon={<MdAutoFixHigh />} label="Corrections proposées" count={fixes.length} />
          {fixes.map((f, i) => {
            const status = fixStatus[i] ?? "pending";
            if (status === "applied") return <ResolvedRow key={`f${i}`} label={`✓ Appliqué : ${(fixEdit[i] ?? f.correction)}`} onUndo={() => setFixStatus((s) => ({ ...s, [i]: "pending" }))} />;
            if (status === "skipped") return <ResolvedRow key={`f${i}`} label="Correction ignorée" onUndo={() => setFixStatus((s) => ({ ...s, [i]: "pending" }))} />;
            return (
              <div key={`f${i}`} style={card}>
                <div style={{ fontSize: 12.5, color: "var(--text-muted)", textDecoration: "line-through" }}>{f.quote}</div>
                <input value={fixEdit[i] ?? f.correction} onChange={(e) => setFixEdit((s) => ({ ...s, [i]: e.target.value }))} style={smallInput} />
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <button onClick={() => applyFix(i, f)} style={actionBtn(true)}><MdCheck /> Appliquer</button>
                  <button onClick={() => setFixStatus((s) => ({ ...s, [i]: "skipped" }))} style={actionBtn()}><MdClose /> Ignorer</button>
                  <ReplayButton start={f.start} end={f.end} play={play} ready={ready} />
                  {f.confidence != null && (
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>confiance {Math.round(f.confidence * 100)}%</span>
                  )}
                </div>
              </div>
            );
          })}

          <GroupLabel icon={<MdHelpOutline />} label="Phrases à clarifier" count={unclear.length} />
          {unclear.map((u, i) => {
            const status = unclearStatus[i] ?? "pending";
            if (status !== "pending") return <ResolvedRow key={`u${i}`} label={status === "applied" ? "✓ Reformulé dans le texte" : "Laissé tel quel"} onUndo={() => setUnclearStatus((s) => ({ ...s, [i]: "pending" }))} />;
            return (
              <div key={`u${i}`} style={card}>
                <div style={{ fontSize: 12.5, color: "var(--text-muted)", fontStyle: "italic" }}>« {u.quote} »</div>
                <input value={unclearEdit[i] ?? u.proposed} onChange={(e) => setUnclearEdit((s) => ({ ...s, [i]: e.target.value }))} style={smallInput} />
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <button onClick={() => replaceUnclear(i, u)} style={actionBtn(true)}><MdCheck /> Reformuler</button>
                  <button onClick={() => setUnclearStatus((s) => ({ ...s, [i]: "skipped" }))} style={actionBtn()}><MdClose /> Laisser</button>
                  <ReplayButton start={u.start} end={u.end} play={play} ready={ready} />
                </div>
              </div>
            );
          })}

          <GroupLabel icon={<MdPersonOutline />} label="Responsable manquant" count={tasks.length} />
          {tasks.map((t, i) => {
            const status = taskStatus[i] ?? "pending";
            if (status !== "pending") return <ResolvedRow key={`t${i}`} label={status === "applied" ? `✓ ${taskOwner[i] ? "Responsable : " + taskOwner[i] : "Sans responsable"}` : "Ignoré"} onUndo={() => setTaskStatus((s) => ({ ...s, [i]: "pending" }))} />;
            return (
              <div key={`t${i}`} style={card}>
                <div style={{ fontSize: 13, color: "var(--text-primary)" }}>{t.task}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{t.question}</div>
                <input placeholder="Responsable (prénom)" value={taskOwner[i] ?? ""} onChange={(e) => setTaskOwner((s) => ({ ...s, [i]: e.target.value }))} style={smallInput} />
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => assignTask(i, t)} style={actionBtn(true)}><MdCheck /> Valider</button>
                  <button onClick={() => setTaskStatus((s) => ({ ...s, [i]: "skipped" }))} style={actionBtn()}><MdClose /> Ignorer</button>
                </div>
              </div>
            );
          })}

          <GroupLabel icon={<MdLightbulbOutline />} label="À retenir sur votre contexte" count={adds.length} />
          {adds.map((a, i) => (
            <div key={`a${i}`} style={{ ...card, flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={a.accepted} onChange={(e) => setAdds((prev) => prev.map((x, k) => (k === i ? { ...x, accepted: e.target.checked } : x)))} style={{ flexShrink: 0, accentColor: "var(--accent)" }} />
              <input value={a.fact} onChange={(e) => setAdds((prev) => prev.map((x, k) => (k === i ? { ...x, fact: e.target.value } : x)))} style={{ ...smallInput, opacity: a.accepted ? 1 : 0.5 }} />
            </div>
          ))}
          {adds.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "0 2px" }}>Les faits cochés sont ajoutés à « Appris automatiquement » dans votre note de contexte.</div>
          )}
        </div>
      </div>
    </div>
  );
}
