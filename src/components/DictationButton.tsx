import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MdMic, MdStop, MdAutorenew } from "react-icons/md";
import { useRecordingStore } from "../store/recordingStore";
import { useT } from "../i18n";

// Dictée vocale (spec/07b) : bouton micro dans une barre de saisie. Clic →
// capture éphémère (start_dictation) ; stop → Whisper transcrit et le texte est
// INSÉRÉ dans le champ (éditable, jamais d'envoi automatique). L'audio est un
// clip temporaire supprimé par le backend — aucune note, aucune ingestion.
// Désactivé pendant un enregistrement de réunion (capture = singleton).

type DictationState = "idle" | "recording" | "transcribing";

export default function DictationButton({
  onText,
  size = 18,
}: {
  /** Reçoit le texte transcrit — l'appelant l'insère dans son champ. */
  onText: (text: string) => void;
  size?: number;
}) {
  const t = useT();
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string | null>(null);
  const recStatus = useRecordingStore((s) => s.status);
  const mounted = useRef(true);

  const meetingBusy = recStatus !== "idle" && recStatus !== "error";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Quitter l'écran en pleine dictée → on annule proprement (WAV jeté).
      invoke("cancel_dictation").catch(() => {});
    };
  }, []);

  const start = async () => {
    setError(null);
    try {
      await invoke("start_dictation");
      setState("recording");
    } catch (e) {
      setError(String(e));
      setState("idle");
    }
  };

  const stop = async () => {
    setState("transcribing");
    try {
      const text = await invoke<string>("stop_dictation");
      if (!mounted.current) return;
      if (text.trim()) onText(text.trim());
      setState("idle");
    } catch (e) {
      // Dégradation gracieuse (spec/07b) : message court, le texte déjà tapé
      // est conservé par l'appelant, la saisie clavier reste disponible.
      if (mounted.current) {
        setError(String(e));
        setState("idle");
      }
    }
  };

  const title = meetingBusy
    ? t("recording.dictation.titleUnavailable")
    : state === "recording"
      ? t("recording.dictation.titleStop")
      : state === "transcribing"
        ? t("recording.dictation.titleTranscribing")
        : error
          ? t("recording.dictation.titleError", { error })
          : t("recording.dictation.titleIdle");

  return (
    <button
      onClick={state === "recording" ? stop : state === "idle" ? start : undefined}
      disabled={meetingBusy || state === "transcribing"}
      title={title}
      style={{
        background: state === "recording" ? "var(--danger)" : "none",
        color: state === "recording" ? "#fff" : error ? "var(--danger)" : "var(--text-secondary)",
        border: state === "recording" ? "none" : "1px solid var(--border)",
        borderRadius: 8, padding: 6, cursor: meetingBusy || state === "transcribing" ? "default" : "pointer",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        opacity: meetingBusy ? 0.45 : 1,
        animation: state === "recording" ? "alfred-pulse 1.4s ease-in-out infinite" : "none",
        flexShrink: 0,
      }}
    >
      {state === "recording" ? (
        <MdStop size={size} />
      ) : state === "transcribing" ? (
        <MdAutorenew size={size} style={{ animation: "alfred-spin 0.8s linear infinite" }} />
      ) : (
        <MdMic size={size} />
      )}
    </button>
  );
}
