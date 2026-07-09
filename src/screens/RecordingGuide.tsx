import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { MdMic, MdStop, MdAdd, MdClose, MdCheckCircle, MdWarning, MdHourglassEmpty, MdStickyNote2 } from "react-icons/md";
import { useRecordingStore, useRecordingElapsed } from "../store/recordingStore";
import { useLiveSessionStore } from "../store/liveSessionStore";
import { useNotesStore } from "../store/notesStore";
import VolumeMeter from "../components/VolumeMeter";
import alfredLogo from "../assets/alfred-logo.png";

// The recording guidance page (spec/03): reached by clicking the sidebar logo
// (or the Dashboard's recording card). Shows live feedback (timer + volume) and
// the capture tips that make a recording actually transcribe/extract well.

const DEFAULT_TIPS = [
  "Présentez les participants : prénom + rôle.",
  "Annoncez le sujet / l'objectif en une phrase au début.",
  "Quand vous donnez une tâche, nommez le responsable (prénom).",
  "Récapitulez les décisions à la fin.",
  "Épelez les noms propres ou termes techniques peu courants.",
];

const CAPTURE_TIPS_KEY = "capture_tips";

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ─── Editable capture tips (spec/03: "liste éditable, stockée dans l'app") ─────

function useCaptureTips() {
  const [tips, setTips] = useState<string[]>(DEFAULT_TIPS);
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    invoke<string | null>("get_config", { key: CAPTURE_TIPS_KEY }).then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) setTips(parsed);
        } catch { /* fall back to defaults */ }
      }
      loaded.current = true;
    });
  }, []);

  const persist = (next: string[]) => {
    setTips(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      invoke("set_config", { key: CAPTURE_TIPS_KEY, value: JSON.stringify(next) }).catch(() => {});
    }, 500);
  };

  return { tips, persist };
}

function TipsEditor() {
  const { tips, persist } = useCaptureTips();
  const [editing, setEditing] = useState(false);

  const update = (i: number, text: string) => persist(tips.map((t, idx) => (idx === i ? text : t)));
  const remove = (i: number) => persist(tips.filter((_, idx) => idx !== i));
  const add = () => persist([...tips, ""]);

  return (
    <div className="card" style={{ padding: "18px 22px" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 14.5, fontWeight: 600, color: "var(--text-primary)" }}>
          Conseils de captation
        </h2>
        <button
          onClick={() => setEditing((e) => !e)}
          style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: 12, fontWeight: 500 }}
        >
          {editing ? "Terminer" : "Modifier"}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {tips.map((tip, i) =>
          editing ? (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                value={tip}
                onChange={(e) => update(i, e.target.value)}
                style={{
                  flex: 1, border: "1px solid var(--border)", borderRadius: 6,
                  padding: "6px 10px", fontSize: 13, background: "var(--bg)", color: "var(--text-primary)",
                }}
              />
              <button
                onClick={() => remove(i)}
                title="Retirer"
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex" }}
              >
                <MdClose size={16} />
              </button>
            </div>
          ) : (
            <div key={i} style={{ display: "flex", gap: 8, fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              <span style={{ color: "var(--accent)" }}>•</span>
              <span>{tip}</span>
            </div>
          )
        )}
      </div>

      {editing && (
        <button
          onClick={add}
          style={{
            marginTop: 10, background: "none", border: "1px dashed var(--border)", borderRadius: 6,
            padding: "6px 10px", cursor: "pointer", color: "var(--text-secondary)", fontSize: 12.5,
            display: "inline-flex", alignItems: "center", gap: 6,
          }}
        >
          <MdAdd size={14} /> Ajouter un conseil
        </button>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function RecordingGuide() {
  const navigate = useNavigate();
  const { status, volume, errorMessage, startRecording, stopRecording } = useRecordingStore();
  const elapsed = useRecordingElapsed();
  const liveActive = useLiveSessionStore((s) => s.active);
  const liveNotePath = useLiveSessionStore((s) => s.notePath);

  const openLiveNote = async () => {
    if (!liveNotePath) return;
    await useNotesStore.getState().selectFile(liveNotePath);
    navigate("/notes");
  };

  const isIdle = status === "idle";
  const isRecording = status === "recording";
  const isProcessing = status === "stopping" || status === "processing";
  const isError = status === "error";

  return (
    <div style={{ height: "100%", overflowY: "auto", display: "flex", justifyContent: "center", padding: "40px 24px" }}>
      <div style={{ width: "100%", maxWidth: 560, display: "flex", flexDirection: "column", gap: 20 }}>
        <div className="card" style={{ padding: "32px 28px", display: "flex", flexDirection: "column", alignItems: "center", gap: 16, textAlign: "center" }}>
          <img src={alfredLogo} alt="Alfred" style={{ width: 56, height: "auto", borderRadius: 14 }} />

          {isRecording && (
            <>
              <div style={{ fontVariantNumeric: "tabular-nums", fontSize: 34, fontWeight: 700, color: "var(--danger)" }}>
                {formatDuration(elapsed)}
              </div>
              <VolumeMeter volume={volume} size="lg" />
              <div style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>Parlez naturellement — Alfred transcrit ensuite en local.</div>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={stopRecording}
                  style={{
                    background: "var(--danger)", color: "#fff", border: "none", borderRadius: 10,
                    padding: "10px 24px", cursor: "pointer", fontSize: 14, fontWeight: 600,
                    display: "inline-flex", alignItems: "center", gap: 8,
                  }}
                >
                  <MdStop size={18} /> Arrêter
                </button>
                {liveActive && liveNotePath && (
                  <button
                    onClick={openLiveNote}
                    style={{
                      background: "none", border: "1px solid var(--border)", borderRadius: 10,
                      padding: "10px 18px", cursor: "pointer", color: "var(--text-primary)",
                      fontSize: 13.5, fontWeight: 500,
                      display: "inline-flex", alignItems: "center", gap: 8,
                    }}
                  >
                    <MdStickyNote2 size={16} /> Ouvrir la note en direct
                  </button>
                )}
              </div>
            </>
          )}

          {isProcessing && (
            <>
              <MdHourglassEmpty size={32} style={{ color: "var(--text-muted)" }} />
              <div style={{ fontSize: 16, color: "var(--text-secondary)" }}>Transcription en cours…</div>
              <button
                onClick={() => navigate("/")}
                style={{ background: "none", border: "1px solid var(--border)", borderRadius: 8, padding: "7px 16px", cursor: "pointer", color: "var(--text-secondary)", fontSize: 13 }}
              >
                Continuer sur l'accueil →
              </button>
            </>
          )}

          {isError && (
            <>
              <MdWarning size={28} style={{ color: "var(--danger)" }} />
              <div style={{ fontSize: 14, color: "var(--danger)" }}>{errorMessage ?? "Erreur inconnue"}</div>
              <button
                onClick={() => startRecording()}
                style={{ background: "var(--accent)", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontSize: 13.5, fontWeight: 500 }}
              >
                Réessayer
              </button>
            </>
          )}

          {isIdle && (
            <>
              <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>Prêt quand vous l'êtes</div>
              <div style={{ fontSize: 13.5, color: "var(--text-secondary)", maxWidth: 380 }}>
                Un dernier coup d'œil aux conseils ci-dessous, puis lancez l'enregistrement.
              </div>
              <button
                onClick={() => startRecording()}
                style={{
                  background: "var(--accent)", color: "#fff", border: "none", borderRadius: 10,
                  padding: "10px 24px", cursor: "pointer", fontSize: 14, fontWeight: 600,
                  display: "inline-flex", alignItems: "center", gap: 8,
                }}
              >
                <MdMic size={18} /> Démarrer l'enregistrement
              </button>
            </>
          )}
        </div>

        <TipsEditor />

        {isIdle && (
          <div style={{ display: "flex", justifyContent: "center" }}>
            <button
              onClick={() => navigate("/")}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <MdCheckCircle size={15} /> Retour à l'accueil
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
