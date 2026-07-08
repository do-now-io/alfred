import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { MdClose } from "react-icons/md";
import { useTourStore } from "../../store/tourStore";
import { useChatStore } from "../../store/chatStore";
import { Spotlight } from "./Spotlight";
import alfredLogo from "../../assets/alfred-logo.png";

// The guided tour (spec/13): a real, event-driven walkthrough right after
// onboarding — record → transcribe → ingest → tasks/notes → ask Alfred.
// Every step reacts to the real backend pipeline; nothing here is simulated,
// and nothing here ever blocks the app underneath (no click-trapping overlay).

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

const CAPTURE_TIPS = [
  "Épelez les noms propres ou termes techniques peu courants.",
  "Quand vous donnez une tâche, nommez la personne responsable.",
  "Récapitulez les décisions prises à la fin.",
];

/** Rotates through a list every `ms`, for the duration of the recording step. */
function useRotatingTip(list: string[], active: boolean, ms = 4500): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setI((n) => (n + 1) % list.length), ms);
    return () => clearInterval(t);
  }, [active, list.length, ms]);
  return list[i];
}

export default function GuidedTour() {
  const { active, step, error, targets, goto, fail, skip, finish } = useTourStore();
  const navigate = useNavigate();
  const location = useLocation();
  const tip = useRotatingTip(CAPTURE_TIPS, active && step === "recording");
  const chatLoading = useChatStore((s) => s.loading);
  const chatMessageCount = useChatStore((s) => s.messages.length);

  // Never fight the router: if the user wanders off during a step that expects
  // them to be on a specific screen, quietly end the tour rather than yank them
  // back or block navigation.
  useEffect(() => {
    if (!active || step !== "record") return;
    if (location.pathname !== "/") skip();
  }, [active, step, location.pathname, skip]);

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
      if (step === "transcribing") goto("writing");
    }).then((fn) => unsubs.push(fn));

    listen<{ status: string }>("ingestion-status-changed", (e) => {
      if (step !== "writing") return;
      if (e.payload.status === "done") goto("done");
      else fail("La rédaction du compte-rendu a échoué, mais votre transcription brute est bien enregistrée.");
    }).then((fn) => unsubs.push(fn));

    return () => unsubs.forEach((fn) => fn());
  }, [active, step, goto, fail]);

  if (!active) return null;

  if (error) {
    return <TourModal title="Petit accroc" text={error} primary="Continuer" onPrimary={() => goto("closing")} />;
  }

  switch (step) {
    case "intro":
      return (
        <TourModal
          title="Une dernière chose…"
          text="Faisons un essai ensemble, pour de vrai : un enregistrement, un compte-rendu, une question à Alfred. Deux minutes montre en main."
          primary="Allons-y"
          onPrimary={() => { navigate("/"); goto("record"); }}
          secondary="Plus tard"
          onSecondary={skip}
        />
      );

    case "record":
      return (
        <>
          <SkipLink onClick={skip} />
          <Spotlight target={targets["hero-card"]}>
            <SpotlightCard text="Cliquez ici pour démarrer, et parlez-lui comme dans une vraie réunion : annoncez le sujet, et si vous donnez une tâche à quelqu'un, nommez-le — Alfred saura à qui la rappeler." />
          </Spotlight>
        </>
      );

    case "recording":
      return (
        <>
          <SkipLink onClick={skip} />
          <TourToast icon="🎙️" text={tip} />
        </>
      );

    case "transcribing":
      return (
        <>
          <SkipLink onClick={skip} />
          <TourToast icon="⏳" text="Alfred est en train de transcrire ce que vous avez dit…" />
        </>
      );

    case "writing":
      return (
        <>
          <SkipLink onClick={skip} />
          <TourToast icon="✍️" text="Il rédige maintenant un résumé et en tire des tâches…" />
        </>
      );

    case "done":
      return (
        <>
          <SkipLink onClick={skip} />
          <Spotlight target={targets["nav-tasks"]}>
            <SpotlightCard
              title="Terminé !"
              text="Retrouvez vos tâches ici, et vos notes juste en dessous."
              onNext={() => { navigate("/ai-actions"); goto("ask"); }}
              nextLabel="Continuer"
            />
          </Spotlight>
        </>
      );

    case "ask":
      return (
        <>
          <SkipLink onClick={skip} />
          <Spotlight target={targets["chat-suggestion-last-meeting"]}>
            <SpotlightCard
              text="Maintenant, demandez-lui de retrouver votre dernière réunion — cliquez sur la suggestion, ou posez votre propre question."
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
          text="Voilà l'essentiel : parlez, Alfred écoute, résume et retient. Le reste, vous le découvrirez en l'utilisant."
          primary="Terminer"
          onPrimary={finish}
        />
      );

    default:
      return null;
  }
}
