import { useState } from "react";
import { MdDeleteOutline, MdArrowForward, MdReplay } from "react-icons/md";
import { useRecordingStore } from "../store/recordingStore";

// Panneau de revue « prise terminée » (spec/03), partagé entre l'enregistrement
// normal et le téléprompteur de la visite guidée (spec/13) — au « purpose » près :
//  - meeting : cases Transcription / Compte-rendu / Tâches (cochées par défaut ;
//    décocher Transcription grise les deux autres) + Supprimer / Continuer.
//  - context : pas de cases (l'aval = structuration du contexte) ;
//    Recommencer (jette la prise) / Continuer.

const checkRow: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, fontSize: 13.5,
  color: "var(--text-primary)", cursor: "pointer", userSelect: "none",
};

function primaryBtn(): React.CSSProperties {
  return {
    background: "var(--accent)", color: "#fff", border: "none", borderRadius: 8,
    padding: "9px 18px", cursor: "pointer", fontSize: 14, fontWeight: 600,
    display: "inline-flex", alignItems: "center", gap: 8,
  };
}

function dangerGhostBtn(): React.CSSProperties {
  return {
    background: "none", color: "var(--danger)", border: "1px solid var(--danger)",
    borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 13.5, fontWeight: 500,
    display: "inline-flex", alignItems: "center", gap: 6,
  };
}

export default function RecordingReview({
  purpose,
  onDiscarded,
  onContinued,
}: {
  purpose: "meeting" | "context";
  /** Après Supprimer/Recommencer (la prise est jetée). */
  onDiscarded?: () => void;
  /** Après Continuer (les traitements cochés sont lancés). */
  onContinued?: () => void;
}) {
  const discardReview = useRecordingStore((s) => s.discardReview);
  const processReview = useRecordingStore((s) => s.processReview);

  const [transcribe, setTranscribe] = useState(true);
  const [summary, setSummary] = useState(true);
  const [tasks, setTasks] = useState(true);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);

  const discard = async () => {
    if (!confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    setBusy(true);
    await discardReview();
    setBusy(false);
    onDiscarded?.();
  };

  const cont = async () => {
    setBusy(true);
    if (purpose === "context") {
      // Mode contexte : l'aval (structuration + glossaire) est routé par le
      // backend via recordings.purpose — pas de compte-rendu ni de tâches.
      await processReview({ transcribe: true, summary: false, tasks: false });
    } else {
      await processReview({ transcribe, summary: transcribe && summary, tasks: transcribe && tasks });
    }
    setBusy(false);
    onContinued?.();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>Prise terminée</div>
        <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
          {purpose === "context"
            ? "Vous pouvez recommencer votre présentation, ou continuer — Alfred la transcrit puis construit votre contexte."
            : "Choisissez ce qu'Alfred doit faire de cet enregistrement."}
        </div>
      </div>

      {purpose === "meeting" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={checkRow}>
            <input
              type="checkbox"
              checked={transcribe}
              onChange={(e) => setTranscribe(e.target.checked)}
              style={{ accentColor: "var(--accent)" }}
            />
            Transcrire l'audio
          </label>
          <label style={{ ...checkRow, opacity: transcribe ? 1 : 0.45, cursor: transcribe ? "pointer" : "default" }}>
            <input
              type="checkbox"
              checked={transcribe && summary}
              disabled={!transcribe}
              onChange={(e) => setSummary(e.target.checked)}
              style={{ accentColor: "var(--accent)" }}
            />
            Créer le compte-rendu
          </label>
          <label style={{ ...checkRow, opacity: transcribe ? 1 : 0.45, cursor: transcribe ? "pointer" : "default" }}>
            <input
              type="checkbox"
              checked={transcribe && tasks}
              disabled={!transcribe}
              onChange={(e) => setTasks(e.target.checked)}
              style={{ accentColor: "var(--accent)" }}
            />
            Créer les tâches
          </label>
          {!transcribe && (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Sans transcription, seul l'audio (.wav) est conservé dans votre vault.
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={discard} disabled={busy} style={dangerGhostBtn()}>
          {purpose === "context" ? <MdReplay size={16} /> : <MdDeleteOutline size={16} />}
          {confirmDiscard
            ? "Confirmer la suppression ?"
            : purpose === "context"
              ? "Recommencer"
              : "Supprimer"}
        </button>
        <button onClick={cont} disabled={busy} style={{ ...primaryBtn(), marginLeft: "auto" }}>
          Continuer <MdArrowForward size={16} />
        </button>
      </div>
    </div>
  );
}
