import { useState } from "react";
import { MdReplay, MdArrowForward } from "react-icons/md";
import { useRecordingStore } from "../store/recordingStore";

// Panneau de revue « prise terminée » du téléprompteur de contexte (spec/03,
// spec/13) — Recommencer (jette la prise) / Continuer (transcrit puis
// structure le contexte). Les réunions n'y passent plus : depuis spec/03
// (« tout auto »), stop_recording lance directement transcription+ingestion.

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
  onDiscarded,
  onContinued,
}: {
  /** Après Recommencer (la prise est jetée). */
  onDiscarded?: () => void;
  /** Après Continuer (transcription + structuration du contexte). */
  onContinued?: () => void;
}) {
  const discardReview = useRecordingStore((s) => s.discardReview);
  const processReview = useRecordingStore((s) => s.processReview);

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
    // Structuration + glossaire routés par le backend via recordings.purpose
    // — pas de compte-rendu ni de tâches.
    await processReview({ transcribe: true, summary: false, tasks: false });
    setBusy(false);
    onContinued?.();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>Prise terminée</div>
        <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
          Vous pouvez recommencer votre présentation, ou continuer — je la transcris puis je construis votre contexte.
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={discard} disabled={busy} style={dangerGhostBtn()}>
          <MdReplay size={16} />
          {confirmDiscard ? "Confirmer la suppression ?" : "Recommencer"}
        </button>
        <button onClick={cont} disabled={busy} style={{ ...primaryBtn(), marginLeft: "auto" }}>
          Continuer <MdArrowForward size={16} />
        </button>
      </div>
    </div>
  );
}
