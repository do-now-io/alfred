import { MdMic, MdStop, MdFiberManualRecord, MdPause, MdPlayArrow } from "react-icons/md";
import { useRecordingStore } from "../../store/recordingStore";
import RecordingReview from "../RecordingReview";

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

const SCRIPT: ScriptItem[] = [
  { n: 1, title: "Qui vous êtes", hint: "Votre prénom, votre rôle, votre entreprise et ce qu'elle fait." },
  { n: 2, title: "Ce que vous allez enregistrer", hint: "Quels types de réunions ou d'échanges (points d'équipe, appels clients, notes perso…)." },
  { n: 3, title: "Votre équipe", hint: "Les prénoms de vos collègues proches et leur rôle (« Marie, cheffe de projet ; Tom, dev back… »)." },
  { n: 4, title: "Vos clients / partenaires", hint: "Les noms d'entreprises et de personnes qui reviennent souvent." },
  { n: 5, title: "Vos projets en cours", hint: "Leurs noms — surtout les noms de code inhabituels." },
  { n: 6, title: "Votre vocabulaire", hint: "Les mots, sigles et outils que vous employez souvent. Ex. : « je dis Kube pour Kubernetes, et j'utilise Grafana, GitHub, Terraform… »." },
];

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
                Présentez-vous à Alfred
              </h2>
              <p style={{ margin: "6px 0 0", fontSize: 13.5, lineHeight: 1.55, color: "var(--text-secondary)" }}>
                Parlez naturellement, comme si vous décriviez votre travail à un nouveau collègue.
                Épelez les noms inhabituels. Besoin d'une pause ? Mettez en pause et reprenez quand
                vous voulez — vous pourrez recommencer ou tout relire et corriger juste après.
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
                    {paused ? "En pause" : "Enregistrement"} · {fmt(elapsed)}
                  </span>
                  <button onClick={paused ? resumeRecording : pauseRecording} style={{ ...ghostControl, marginLeft: "auto" }}>
                    {paused ? <><MdPlayArrow size={16} /> Reprendre</> : <><MdPause size={15} /> Pause</>}
                  </button>
                  <button
                    onClick={onStop}
                    style={{
                      background: "var(--accent)", color: "#fff", border: "none",
                      borderRadius: 8, padding: "9px 18px", cursor: "pointer", fontSize: 14, fontWeight: 600,
                      display: "flex", alignItems: "center", gap: 8,
                    }}
                  >
                    <MdStop /> J'ai terminé
                  </button>
                </>
              ) : (
                <>
                  <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                    Prêt ? Lancez et déroulez les points ci-dessus.
                  </span>
                  <button
                    onClick={onStart}
                    style={{
                      marginLeft: "auto", background: "var(--accent)", color: "#fff", border: "none",
                      borderRadius: 8, padding: "9px 18px", cursor: "pointer", fontSize: 14, fontWeight: 600,
                      display: "flex", alignItems: "center", gap: 8,
                    }}
                  >
                    <MdMic /> Commencer l'enregistrement
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
