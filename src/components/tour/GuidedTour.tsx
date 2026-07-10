import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { MdClose } from "react-icons/md";
import { useTourStore } from "../../store/tourStore";
import { useChatStore } from "../../store/chatStore";
import { useRecordingStore, useRecordingElapsed } from "../../store/recordingStore";
import { useNotesStore } from "../../store/notesStore";
import type { NoteFile } from "../../bindings/NoteFile";
import { Spotlight } from "./Spotlight";
import Teleprompter from "./Teleprompter";
import alfredLogo from "../../assets/alfred-logo.png";

// The guided tour (spec/13): a real, event-driven walkthrough right after
// onboarding. The first recording IS the creation of `Contexte Alfred.md` — the
// user introduces themselves aloud (teleprompter), Alfred transcribes, structures
// the context note and derives the glossary, then answers a question about it.
// Every step reacts to the real backend pipeline; nothing here is simulated.

const ACCENT = "var(--accent)";

function primaryBtn(): React.CSSProperties {
  return {
    background: ACCENT, color: "#fff", border: "none", borderRadius: 8,
    padding: "8px 16px", cursor: "pointer", fontSize: 13.5, fontWeight: 500,
  };
}

function ghostBtn(): React.CSSProperties {
  return { background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 13 };
}

function SkipLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        position: "fixed", top: 16, right: 16, zIndex: 2200,
        background: "var(--card-bg)", border: "1px solid var(--border)",
        borderRadius: 8, padding: "6px 12px", cursor: "pointer",
        fontSize: 12.5, color: "var(--text-muted)",
        display: "flex", alignItems: "center", gap: 6,
      }}
    >
      <MdClose size={14} /> Passer la visite
    </button>
  );
}

// Centered card — the opening and closing beats.
function TourModal({
  title, text, primary, onPrimary, secondary, onSecondary, glow,
}: {
  title: string; text: string;
  primary: string; onPrimary: () => void;
  secondary?: string; onSecondary?: () => void;
  glow?: boolean;
}) {
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 2200,
      background: "rgba(0,0,0,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div className="card" style={{
        width: "100%", maxWidth: 440, padding: "36px 32px 28px", margin: 16,
        display: "flex", flexDirection: "column", alignItems: "center", gap: 16,
        textAlign: "center", boxShadow: glow
          ? `0 0 60px -8px ${ACCENT}, 0 12px 48px rgba(0,0,0,0.3)`
          : "0 12px 48px rgba(0,0,0,0.3)",
        transition: "box-shadow 0.6s ease",
      }}>
        <img src={alfredLogo} alt="Alfred" style={{ width: 56, height: "auto", borderRadius: 14 }} />
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "var(--text-primary)" }}>{title}</h2>
        <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, color: "var(--text-secondary)" }}>{text}</p>
        <div style={{ display: "flex", alignItems: "center", gap: 18, marginTop: 8 }}>
          {secondary && <button onClick={onSecondary} style={ghostBtn()}>{secondary}</button>}
          <button onClick={onPrimary} style={primaryBtn()}>{primary}</button>
        </div>
      </div>
    </div>
  );
}

// Small floating, non-blocking status pill — recording/transcribing/writing.
// Deliberately top-right and tiny: the point is to inform, never to get in the way.
function TourToast({ icon, text }: { icon: string; text: string }) {
  return (
    <div style={{
      position: "fixed", top: 64, right: 24, zIndex: 2100,
      background: "var(--card-bg)", border: "1px solid var(--border)",
      borderRadius: 12, padding: "10px 16px",
      display: "flex", alignItems: "center", gap: 10,
      fontSize: 13, color: "var(--text-primary)",
      boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
      maxWidth: 320, transition: "opacity 0.3s ease",
    }}>
      <span style={{ fontSize: 16, flexShrink: 0 }}>{icon}</span>
      {text}
    </div>
  );
}

function SpotlightCard({
  title, text, onNext, nextLabel = "Suivant",
}: { title?: string; text: string; onNext?: () => void; nextLabel?: string }) {
  return (
    <div className="card" style={{
      padding: "16px 18px", boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
      display: "flex", flexDirection: "column", gap: 10,
    }}>
      {title && <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{title}</div>}
      <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text-secondary)" }}>{text}</div>
      {onNext && (
        <button onClick={onNext} style={{ ...primaryBtn(), alignSelf: "flex-end", padding: "6px 14px" }}>
          {nextLabel}
        </button>
      )}
    </div>
  );
}

export default function GuidedTour() {
  const { active, step, error, targets, goto, fail, skip, finish } = useTourStore();
  const navigate = useNavigate();
  const chatLoading = useChatStore((s) => s.loading);
  const chatMessageCount = useChatStore((s) => s.messages.length);
  const startRecording = useRecordingStore((s) => s.startRecording);
  const stopRecording = useRecordingStore((s) => s.stopRecording);
  const selectFile = useNotesStore((s) => s.selectFile);
  const elapsed = useRecordingElapsed();
  // Recap numbers from `context-status-changed` (sections filled + glossary size).
  const [recap, setRecap] = useState<{ sections: number; terms: number }>({ sections: 0, terms: 0 });

  // Auto-advance once a chat reply lands, while on the "ask" step.
  useEffect(() => {
    if (active && step === "ask" && !chatLoading && chatMessageCount > 0) {
      goto("closing");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatLoading]);

  useEffect(() => {
    if (!active) return;
    const unsubs: Array<() => void> = [];

    listen<{ status: string }>("recording-status-changed", (e) => {
      if (step === "record" && e.payload.status === "recording") goto("recording");
      if (step === "recording" && (e.payload.status === "stopping" || e.payload.status === "processing")) {
        goto("transcribing");
      }
      if (e.payload.status === "error" && (step === "record" || step === "recording")) {
        fail("L'enregistrement a rencontré un problème — pas de souci, vous pourrez réessayer plus tard.");
      }
    }).then((fn) => unsubs.push(fn));

    listen("transcription-complete", () => {
      if (step === "transcribing") goto("structuring");
    }).then((fn) => unsubs.push(fn));

    listen<{ status: string; sections_filled?: number; glossary_terms?: number }>("context-status-changed", (e) => {
      if (step !== "structuring") return;
      if (e.payload.status === "done") {
        setRecap({ sections: e.payload.sections_filled ?? 0, terms: e.payload.glossary_terms ?? 0 });
        goto("ready");
      } else {
        fail("Alfred n'a pas réussi à construire votre contexte, mais votre transcription est bien enregistrée. Vous pourrez remplir la note de contexte à la main.");
      }
    }).then((fn) => unsubs.push(fn));

    return () => unsubs.forEach((fn) => fn());
  }, [active, step, goto, fail]);

  if (!active) return null;

  if (error) {
    return <TourModal title="Petit accroc" text={error} primary="Continuer" onPrimary={() => goto("closing")} />;
  }

  const openContextNote = async () => {
    try {
      const note = await invoke<NoteFile>("open_context_note");
      await selectFile(note.path);
      navigate("/notes");
    } catch (e) {
      console.error("[tour] open_context_note failed:", e);
    }
    finish();
  };

  switch (step) {
    case "intro":
      return (
        <TourModal
          title="Apprenons à Alfred qui vous êtes"
          text="Vous allez vous présenter à voix haute pendant qu'Alfred vous transcrit — il s'en servira pour bien orthographier vos collègues, vos clients et votre jargon. Deux minutes."
          primary="Allons-y"
          onPrimary={() => goto("record")}
          secondary="Plus tard"
          onSecondary={skip}
        />
      );

    case "record":
      return (
        <>
          <SkipLink onClick={skip} />
          <Teleprompter
            recording={false}
            elapsed={0}
            onStart={() => startRecording("mic_only", "context")}
            onStop={() => {}}
          />
        </>
      );

    case "recording":
      return (
        <>
          <SkipLink onClick={skip} />
          <Teleprompter recording elapsed={elapsed} onStart={() => {}} onStop={stopRecording} />
        </>
      );

    case "transcribing":
      return (
        <>
          <SkipLink onClick={skip} />
          <TourToast icon="⏳" text="Alfred écoute et met au propre ce que vous venez de dire…" />
        </>
      );

    case "structuring":
      return (
        <>
          <SkipLink onClick={skip} />
          <TourToast icon="🗂️" text="Il range tout ça : votre entreprise, votre équipe, vos projets, votre vocabulaire…" />
        </>
      );

    case "ready":
      return (
        <TourModal
          glow
          title="Alfred vous connaît maintenant !"
          text={
            recap.terms > 0
              ? `Votre contexte est prêt (${recap.sections} section${recap.sections > 1 ? "s" : ""} remplie${recap.sections > 1 ? "s" : ""}) et ${recap.terms} noms propres ont rejoint le glossaire de transcription.`
              : "Votre contexte est prêt. Vous pourrez le compléter à tout moment."
          }
          primary="Continuer"
          onPrimary={() => { navigate("/ai-actions"); goto("ask"); }}
          secondary="Relire / corriger"
          onSecondary={openContextNote}
        />
      );

    case "ask":
      return (
        <>
          <SkipLink onClick={skip} />
          <Spotlight target={targets["chat-suggestion-my-context"]}>
            <SpotlightCard
              text="Vérifiez qu'il a bien retenu : demandez-lui ce qu'il sait de votre équipe et de vos projets — cliquez sur la suggestion, ou posez votre propre question."
              onNext={() => goto("closing")}
              nextLabel="Voir la suite"
            />
          </Spotlight>
        </>
      );

    case "closing":
      return (
        <TourModal
          glow
          title="Vous êtes équipé"
          text="Désormais : parlez, Alfred écoute, résume et retient — et il connaît votre univers. Le reste, vous le découvrirez en l'utilisant."
          primary="Terminer"
          onPrimary={finish}
        />
      );

    default:
      return null;
  }
}
