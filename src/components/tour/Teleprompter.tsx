import { MdMic, MdStop, MdFiberManualRecord, MdPause, MdPlayArrow } from "react-icons/md";
import { useRecordingStore } from "../../store/recordingStore";
import RecordingReview from "../RecordingReview";
import { useT } from "../../i18n";

// The context-recording script (spec/13). Guides, never dictates: the user
// paraphrases at their own pace. The point is to surface as many proper nouns /
// jargon as possible — that's the raw material of the Whisper glossary.
//
// Contrôles enrichis (feedback tests) : Pause / Reprendre pendant la prise ;
// « J'ai terminé » → état « prise terminée » avec Recommencer / Continuer
// (panneau de revue partagé avec l'enregistrement normal, spec/03).

interface ScriptItem {
  n: number;
  title: string;
  hint: string;
}

// Le script est construit à partir de `t()` DANS le composant (et non en
// constante de module) pour rester réactif au changement de langue (spec/21).
function buildScript(t: ReturnType<typeof useT>): ScriptItem[] {
  return [
    { n: 1, title: t("tour.teleprompter.script.item1.title"), hint: t("tour.teleprompter.script.item1.hint") },
    { n: 2, title: t("tour.teleprompter.script.item2.title"), hint: t("tour.teleprompter.script.item2.hint") },
    { n: 3, title: t("tour.teleprompter.script.item3.title"), hint: t("tour.teleprompter.script.item3.hint") },
    { n: 4, title: t("tour.teleprompter.script.item4.title"), hint: t("tour.teleprompter.script.item4.hint") },
    { n: 5, title: t("tour.teleprompter.script.item5.title"), hint: t("tour.teleprompter.script.item5.hint") },
    { n: 6, title: t("tour.teleprompter.script.item6.title"), hint: t("tour.teleprompter.script.item6.hint") },
  ];
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const ghostControl: React.CSSProperties = {
  background: "none", color: "var(--text-secondary)", border: "1px solid var(--border)",
  borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 13.5, fontWeight: 500,
  display: "flex", alignItems: "center", gap: 6,
};

export default function Teleprompter({
  elapsed, onStart, onStop, onDiscarded, onContinued,
}: {
  elapsed: number;
  onStart: () => void;
  onStop: () => void;
  /** Recommencer depuis la revue — la prise est jetée, on repart à zéro. */
  onDiscarded: () => void;
  /** Continuer depuis la revue — la transcription (mode contexte) démarre. */
  onContinued: () => void;
}) {
  const t = useT();
  const SCRIPT = buildScript(t);
  const status = useRecordingStore((s) => s.status);
  const pauseRecording = useRecordingStore((s) => s.pauseRecording);
  const resumeRecording = useRecordingStore((s) => s.resumeRecording);

  const paused = status === "paused";
  const recording = status === "recording" || paused;
  const review = status === "stopped";

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 2200,
      background: "rgba(0,0,0,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
    }}>
      <div className="card" style={{
        width: "100%", maxWidth: 560, maxHeight: "88vh", padding: "28px 30px 24px",
        display: "flex", flexDirection: "column", gap: 16,
        boxShadow: "0 12px 48px rgba(0,0,0,0.3)",
      }}>
        {review ? (
          <RecordingReview onDiscarded={onDiscarded} onContinued={onContinued} />
        ) : (
          <>
            <div>
              <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: "var(--text-primary)" }}>
                {t("tour.teleprompter.header.title")}
              </h2>
              <p style={{ margin: "6px 0 0", fontSize: 13.5, lineHeight: 1.55, color: "var(--text-secondary)" }}>
                {t("tour.teleprompter.header.text")}
              </p>
            </div>

            <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingRight: 4 }}>
              {SCRIPT.map((item) => (
                <div key={item.n} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <span style={{
                    flexShrink: 0, width: 22, height: 22, borderRadius: "50%",
                    background: "var(--active-bg)", color: "var(--accent)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 12, fontWeight: 700, marginTop: 1,
                  }}>{item.n}</span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{item.title}</div>
                    <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text-secondary)" }}>{item.hint}</div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 12, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
              {recording ? (
                <>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, color: paused ? "var(--text-muted)" : "var(--danger)", fontSize: 13, fontWeight: 600 }}>
                    <MdFiberManualRecord style={{ animation: paused ? "none" : "alfred-pulse 1.4s ease-in-out infinite" }} />
                    {paused ? t("tour.teleprompter.paused") : t("tour.teleprompter.recording")} · {fmt(elapsed)}
                  </span>
                  <button onClick={paused ? resumeRecording : pauseRecording} style={{ ...ghostControl, marginLeft: "auto" }}>
                    {paused ? <><MdPlayArrow size={16} /> {t("tour.teleprompter.resume")}</> : <><MdPause size={15} /> {t("tour.teleprompter.pause")}</>}
                  </button>
                  <button
                    onClick={onStop}
                    style={{
                      background: "var(--accent)", color: "#fff", border: "none",
                      borderRadius: 8, padding: "9px 18px", cursor: "pointer", fontSize: 14, fontWeight: 600,
                      display: "flex", alignItems: "center", gap: 8,
                    }}
                  >
                    <MdStop /> {t("tour.teleprompter.finish")}
                  </button>
                </>
              ) : (
                <>
                  <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                    {t("tour.teleprompter.readyHint")}
                  </span>
                  <button
                    onClick={onStart}
                    style={{
                      marginLeft: "auto", background: "var(--accent)", color: "#fff", border: "none",
                      borderRadius: 8, padding: "9px 18px", cursor: "pointer", fontSize: 14, fontWeight: 600,
                      display: "flex", alignItems: "center", gap: 8,
                    }}
                  >
                    <MdMic /> {t("tour.teleprompter.start")}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
