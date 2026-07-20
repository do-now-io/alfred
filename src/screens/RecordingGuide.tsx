import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { MdMic, MdStop, MdAdd, MdClose, MdCheckCircle, MdWarning, MdHourglassEmpty, MdPause, MdPlayArrow } from "react-icons/md";
import { useRecordingStore, useRecordingElapsed } from "../store/recordingStore";
import { useAlfredStatusStore } from "../store/alfredStatusStore";
import VolumeMeter from "../components/VolumeMeter";
import AlfredAvatar from "../components/AlfredAvatar";

// The recording guidance page (spec/03): reached by clicking the sidebar logo
// (or the Dashboard's recording card). Shows live feedback (timer + volume) and
// the capture tips that make a recording actually transcribe/extract well.

// Conseils de captation PAR TYPE (spec/03, feedback tests) : chaque type de
// captation a sa phrase d'ouverture (ce qu'il faut dire en premier) + ses
// conseils ciblés. Config `capture_tips` = dict `{ [type]: { opener, tips[] } }`
// (l'ancienne liste plate est migrée vers le type « libre »).

interface CaptureTypeTips {
  opener: string;
  tips: string[];
}

const CAPTURE_TYPES: Array<{ id: string; label: string }> = [
  { id: "perso", label: "Note personnelle" },
  { id: "client", label: "Réunion client" },
  { id: "one2one", label: "One-to-one" },
  { id: "equipe", label: "Réunion d'équipe" },
  { id: "libre", label: "Autre / libre" },
];

const DEFAULT_TIPS_BY_TYPE: Record<string, CaptureTypeTips> = {
  perso: {
    opener: "« Ceci est une note personnelle sur … »",
    tips: [
      "Annoncez le contexte et le sujet en une phrase.",
      "Datez les éléments importants (« à faire pour vendredi »).",
      "Épelez les noms propres ou termes techniques peu courants.",
    ],
  },
  client: {
    opener: "« Réunion avec le client {nom}, participants : … »",
    tips: [
      "Nommez TOUS les participants (côté client et interne) et leur rôle.",
      "Citez le nom du client et du projet concerné.",
      "Quand vous donnez une tâche, nommez le responsable (prénom).",
      "Récapitulez les décisions à la fin.",
      "Épelez les noms propres ou termes techniques peu courants.",
    ],
  },
  one2one: {
    opener: "« One-to-one avec {prénom} »",
    tips: [
      "Annoncez le sujet de l'échange.",
      "Formulez clairement les points d'action et qui s'en charge.",
      "Récapitulez ce qui est convenu à la fin.",
    ],
  },
  equipe: {
    opener: "« Réunion d'équipe {nom}, participants : … »",
    tips: [
      "Présentez les participants internes : prénom + rôle.",
      "Annoncez l'ordre du jour en une phrase.",
      "Quand vous donnez une tâche, nommez le responsable (prénom).",
      "Récapitulez les décisions à la fin.",
    ],
  },
  libre: {
    opener: "Annoncez le sujet / l'objectif en une phrase au début.",
    tips: [
      "Présentez les participants : prénom + rôle.",
      "Quand vous donnez une tâche, nommez le responsable (prénom).",
      "Récapitulez les décisions à la fin.",
      "Épelez les noms propres ou termes techniques peu courants.",
    ],
  },
};

const CAPTURE_TIPS_KEY = "capture_tips";

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ─── Editable capture tips, per type (spec/03) ─────────────────────────────────

function useCaptureTips() {
  const [byType, setByType] = useState<Record<string, CaptureTypeTips>>(DEFAULT_TIPS_BY_TYPE);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    invoke<string | null>("get_config", { key: CAPTURE_TIPS_KEY }).then((raw) => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          // Ancien format (liste plate) → migré vers le type « libre ».
          if (parsed.length > 0) {
            setByType((prev) => ({ ...prev, libre: { ...prev.libre, tips: parsed } }));
          }
        } else if (parsed && typeof parsed === "object") {
          setByType((prev) => {
            const next = { ...prev };
            for (const [k, v] of Object.entries(parsed as Record<string, CaptureTypeTips>)) {
              if (v && typeof v.opener === "string" && Array.isArray(v.tips)) next[k] = v;
            }
            return next;
          });
        }
      } catch { /* fall back to defaults */ }
    });
  }, []);

  const persist = (next: Record<string, CaptureTypeTips>) => {
    setByType(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      invoke("set_config", { key: CAPTURE_TIPS_KEY, value: JSON.stringify(next) }).catch(() => {});
    }, 500);
  };

  return { byType, persist };
}

function TipsEditor() {
  const { byType, persist } = useCaptureTips();
  const [editing, setEditing] = useState(false);
  const [type, setType] = useState("libre");

  const current = byType[type] ?? DEFAULT_TIPS_BY_TYPE.libre;
  const patch = (p: Partial<CaptureTypeTips>) =>
    persist({ ...byType, [type]: { ...current, ...p } });

  const update = (i: number, text: string) => patch({ tips: current.tips.map((t, idx) => (idx === i ? text : t)) });
  const remove = (i: number) => patch({ tips: current.tips.filter((_, idx) => idx !== i) });
  const add = () => patch({ tips: [...current.tips, ""] });

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

      {/* Sélecteur de type (spec/03) — le guidage s'adapte au type de captation. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {CAPTURE_TYPES.map((t) => (
          <button
            key={t.id}
            onClick={() => setType(t.id)}
            style={{
              background: type === t.id ? "var(--active-bg)" : "transparent",
              color: type === t.id ? "var(--accent)" : "var(--text-secondary)",
              border: "1px solid var(--border)", borderRadius: 16,
              padding: "4px 11px", cursor: "pointer", fontSize: 12, fontWeight: type === t.id ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Phrase d'ouverture — ce qu'il faut dire en premier. */}
      <div style={{
        display: "flex", gap: 8, alignItems: "center", marginBottom: 10,
        padding: "8px 12px", borderRadius: 8, background: "var(--active-bg)",
      }}>
        <span style={{ fontSize: 15, flexShrink: 0 }}>🗣️</span>
        {editing ? (
          <input
            value={current.opener}
            onChange={(e) => patch({ opener: e.target.value })}
            style={{
              flex: 1, border: "1px solid var(--border)", borderRadius: 6,
              padding: "5px 9px", fontSize: 13, background: "var(--card-bg)", color: "var(--text-primary)",
            }}
          />
        ) : (
          <span style={{ fontSize: 13.5, color: "var(--text-primary)", fontWeight: 500, lineHeight: 1.5 }}>
            Commencez par : {current.opener}
          </span>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {current.tips.map((tip, i) =>
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
  const { status, volume, errorMessage, startRecording, stopRecording, cancelRecording, pauseRecording, resumeRecording } = useRecordingStore();
  const elapsed = useRecordingElapsed();
  // Progression réelle de la transcription (spec/04, feedback tests).
  const transcriptionPercent = useAlfredStatusStore((s) => (s.state === "transcribing" ? s.progress : null));

  const isIdle = status === "idle";
  const isPaused = status === "paused";
  const isRecording = status === "recording" || isPaused;
  const isProcessing = status === "stopping" || status === "processing";
  const isError = status === "error";

  const cancel = () => {
    if (window.confirm("Supprimer cet enregistrement ? L'audio sera perdu.")) {
      cancelRecording();
    }
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", display: "flex", justifyContent: "center", padding: "40px 24px" }}>
      <div style={{ width: "100%", maxWidth: 560, display: "flex", flexDirection: "column", gap: 20 }}>
        <div className="card" style={{ padding: "32px 28px", display: "flex", flexDirection: "column", alignItems: "center", gap: 16, textAlign: "center" }}>
          <AlfredAvatar size={56} radius={14} />

          {isRecording && (
            <>
              <div style={{ fontVariantNumeric: "tabular-nums", fontSize: 34, fontWeight: 700, color: isPaused ? "var(--text-muted)" : "var(--danger)" }}>
                {formatDuration(elapsed)}
              </div>
              <VolumeMeter volume={volume} size="lg" />
              <div style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>
                {isPaused ? "En pause — reprenez quand vous voulez." : "Parlez naturellement — je transcris ensuite en local."}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  onClick={cancel}
                  title="Annuler — jette l'enregistrement"
                  style={{
                    background: "none", color: "var(--text-muted)", border: "1px solid var(--border)",
                    borderRadius: 10, padding: "9px 16px", cursor: "pointer", fontSize: 13.5,
                    display: "inline-flex", alignItems: "center", gap: 6,
                  }}
                >
                  <MdClose size={16} /> Annuler
                </button>
                <button
                  onClick={isPaused ? resumeRecording : pauseRecording}
                  style={{
                    background: "none", color: "var(--text-secondary)", border: "1px solid var(--border)",
                    borderRadius: 10, padding: "9px 16px", cursor: "pointer", fontSize: 13.5, fontWeight: 500,
                    display: "inline-flex", alignItems: "center", gap: 6,
                  }}
                >
                  {isPaused ? <><MdPlayArrow size={17} /> Reprendre</> : <><MdPause size={16} /> Pause</>}
                </button>
                <button
                  onClick={stopRecording}
                  style={{
                    background: "var(--danger)", color: "#fff", border: "none", borderRadius: 10,
                    padding: "10px 24px", cursor: "pointer", fontSize: 14, fontWeight: 600,
                    display: "inline-flex", alignItems: "center", gap: 8,
                  }}
                >
                  <MdStop size={18} /> Terminer
                </button>
              </div>
            </>
          )}

          {isProcessing && (
            <>
              <MdHourglassEmpty size={32} style={{ color: "var(--text-muted)" }} />
              <div style={{ fontSize: 16, color: "var(--text-secondary)" }}>
                Transcription en cours…{transcriptionPercent != null ? ` ${transcriptionPercent} %` : ""}
              </div>
              {transcriptionPercent != null && (
                <div style={{ width: "100%", maxWidth: 280, height: 6, borderRadius: 4, background: "var(--border)", overflow: "hidden" }}>
                  <div style={{
                    width: `${transcriptionPercent}%`, height: "100%", background: "var(--accent)",
                    borderRadius: 4, transition: "width 0.3s ease",
                  }} />
                </div>
              )}
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
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                Pour importer un fichier audio existant, utilisez le bouton dédié sur le logo Alfred ou la carte d'enregistrement de l'accueil.
              </div>
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
