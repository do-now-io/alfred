import { MdMic, MdStop, MdWarning, MdClose, MdPause, MdPlayArrow } from "react-icons/md";
import { useRecordingStore, useRecordingElapsed } from "../store/recordingStore";
import VolumeMeter from "./VolumeMeter";

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

const btn = (bg: string): React.CSSProperties => ({
  background: bg,
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "5px 12px",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 500,
  display: "flex",
  alignItems: "center",
  gap: 6,
});

/**
 * Compact, view-independent recording indicator. Mounted once in the app's Topbar
 * (which never unmounts on navigation) so a recording started in any view stays
 * visible and stoppable everywhere. The capture itself runs in the Rust backend
 * and keeps going across view changes — this only surfaces and controls it.
 */
export default function RecordingBar() {
  const status = useRecordingStore((s) => s.status);
  const volume = useRecordingStore((s) => s.volume);
  const errorMessage = useRecordingStore((s) => s.errorMessage);
  const startRecording = useRecordingStore((s) => s.startRecording);
  const stopRecording = useRecordingStore((s) => s.stopRecording);
  const cancelRecording = useRecordingStore((s) => s.cancelRecording);
  const pauseRecording = useRecordingStore((s) => s.pauseRecording);
  const resumeRecording = useRecordingStore((s) => s.resumeRecording);
  const elapsed = useRecordingElapsed();

  const cancel = () => {
    // L'audio est perdu (spec/03) — une confirmation s'impose.
    if (window.confirm("Supprimer cet enregistrement ? L'audio sera perdu.")) {
      cancelRecording();
    }
  };

  // Active take (recording/paused: timer + volume + annuler/pause/stop —
  // spec/03/10's bandeau) and errors. Transcription/ingestion progress lives on
  // the butler label under the sidebar logo instead.
  const activeTake = status === "recording" || status === "paused";
  if (!activeTake && status !== "error") return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "5px 6px 5px 12px",
        borderRadius: 10,
        background: status === "recording" ? "#3D0A0A" : "var(--bg)",
        border: "1px solid var(--border)",
      }}
    >
      {activeTake && (
        <>
          <span style={{ color: "var(--danger)", fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--danger)", display: "inline-block", opacity: status === "paused" ? 0.4 : 1 }} />
            {status === "paused" ? "PAUSE" : "REC"}
          </span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 14, color: "var(--text-secondary)" }}>
            {formatDuration(elapsed)}
          </span>
          <VolumeMeter volume={volume} />
          <button
            onClick={cancel}
            title="Annuler — jette l'enregistrement"
            style={{ ...btn("transparent"), color: "var(--text-muted)", border: "1px solid var(--border)", padding: "4px 8px" }}
          >
            <MdClose size={15} />
          </button>
          <button
            onClick={status === "paused" ? resumeRecording : pauseRecording}
            title={status === "paused" ? "Reprendre" : "Mettre en pause"}
            style={{ ...btn("transparent"), color: "var(--text-secondary)", border: "1px solid var(--border)", padding: "4px 8px" }}
          >
            {status === "paused" ? <MdPlayArrow size={16} /> : <MdPause size={15} />}
          </button>
          <button onClick={stopRecording} style={btn("var(--danger)")}>
            <MdStop size={16} /> Terminer
          </button>
        </>
      )}

      {/* stopping/processing intentionally show nothing here — the butler label
          under the sidebar logo is the app's single status readout. */}

      {status === "error" && (
        <>
          <span style={{ color: "var(--danger)", fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
            <MdWarning size={15} /> {errorMessage ?? "Erreur inconnue"}
          </span>
          <button onClick={() => startRecording("mic_only")} style={btn("var(--accent)")}>
            <MdMic size={16} /> Réessayer
          </button>
        </>
      )}
    </div>
  );
}
