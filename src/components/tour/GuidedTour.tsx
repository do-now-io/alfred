import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { MdClose } from "react-icons/md";
import { useTourStore, type TourStep } from "../../store/tourStore";
import { useRecordingStore, useRecordingElapsed } from "../../store/recordingStore";
import { useResolveStore } from "../../store/resolveStore";
import { useAlfredStatusStore } from "../../store/alfredStatusStore";
import type { NoteFile } from "../../bindings/NoteFile";
import { Spotlight } from "./Spotlight";
import Teleprompter from "./Teleprompter";
import { parseContextSections } from "../../screens/Resolve";
import alfredLogo from "../../assets/alfred-logo.png";

// The guided tour (spec/13): a real, event-driven walkthrough right after
// onboarding. The first recording IS the creation of `Contexte Alfred.md` — the
// user introduces themselves aloud (teleprompter with pause + review controls).
// While the pipeline runs, the tour walks the app (Notes → Tâches → Graphe →
// Alfred & enregistrer). As soon as the context is ready, a pop-up interrupts
// the visit — single « Revoir / corriger » button → /resolve in context mode —
// then the closing card. Every step reacts to the real backend pipeline.

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

/** L'indicateur d'état discret pendant la visite (spec/13 étape 3). */
function PipelineToast() {
  const butler = useAlfredStatusStore((s) => s.state);
  if (butler === "transcribing") {
    return <TourToast icon="⏳" text="Pendant ce temps, Alfred écoute et met au propre ce que vous venez de dire…" />;
  }
  return <TourToast icon="🗂️" text="Alfred range tout ça : votre entreprise, votre équipe, vos projets, votre vocabulaire…" />;
}

// The app-visit steps (spec/13 étape 3) — spotlight target id + copy + where to be.
const VISIT_STEPS: Array<{
  step: TourStep; next: TourStep; target: string; route: string;
  title: string; text: string;
}> = [
  {
    step: "visit-notes", next: "visit-tasks", target: "nav-notes", route: "/notes",
    title: "Vos notes",
    text: "Chaque enregistrement produit sa transcription et son compte-rendu, rangés ici — regroupés par projet.",
  },
  {
    step: "visit-tasks", next: "visit-graph", target: "nav-tasks", route: "/tasks",
    title: "Vos tâches",
    text: "Les actions décidées en réunion arrivent toutes seules ici (avec le responsable quand il est nommé). Prioritaire / En cours / À faire — cochez, assignez, archivez.",
  },
  {
    step: "visit-graph", next: "visit-chat", target: "nav-graph", route: "/graph",
    title: "Le graphe",
    text: "Vos notes se relient entre elles par projets et participants — pratique pour retrouver le fil d'un sujet.",
  },
  {
    step: "visit-chat", next: "waiting", target: "nav-chat", route: "/ai-actions",
    title: "Questions à Alfred — et comment enregistrer",
    text: "Posez vos questions ici, Alfred répond en citant vos notes. Et pour enregistrer : cliquez le logo Alfred (en haut à gauche), la carte d'accueil, ou importez un audio.",
  },
];

export default function GuidedTour() {
  const { active, step, error, targets, recap, goto, setRecap, fail, skip, finish } = useTourStore();
  const navigate = useNavigate();
  const startRecording = useRecordingStore((s) => s.startRecording);
  const stopRecording = useRecordingStore((s) => s.stopRecording);
  const setResolveSession = useResolveStore((s) => s.setSession);
  const elapsed = useRecordingElapsed();

  useEffect(() => {
    if (!active) return;
    const unsubs: Array<() => void> = [];

    listen<{ status: string }>("recording-status-changed", (e) => {
      if (e.payload.status === "error" && step === "record") {
        fail("L'enregistrement a rencontré un problème — pas de souci, vous pourrez réessayer plus tard.");
      }
    }).then((fn) => unsubs.push(fn));

    // « Contexte prêt » (spec/13 étape 4) : la pop-up INTERROMPT la visite, où
    // qu'on en soit (étapes visit-* ou waiting).
    listen<{ status: string; recording_id: string; note_title?: string | null; sections_filled?: number; glossary_terms?: number }>(
      "context-status-changed",
      (e) => {
        if (step === "record" || step === "ready" || step === "correcting" || step === "closing") return;
        if (e.payload.status === "done") {
          setRecap({
            sections: e.payload.sections_filled ?? 0,
            terms: e.payload.glossary_terms ?? 0,
            recordingId: e.payload.recording_id,
            noteTitle: e.payload.note_title ?? null,
          });
          goto("ready");
        } else {
          fail("Alfred n'a pas réussi à construire votre contexte, mais votre transcription est bien enregistrée. Vous pourrez remplir la note de contexte à la main.");
        }
      }
    ).then((fn) => unsubs.push(fn));

    return () => unsubs.forEach((fn) => fn());
  }, [active, step, goto, setRecap, fail]);

  if (!active) return null;

  if (error) {
    return <TourModal title="Petit accroc" text={error} primary="Continuer" onPrimary={() => goto("closing")} />;
  }

  // « Revoir / corriger » (spec/13 étape 5) : ouvre /resolve en MODE CONTEXTE —
  // les 4 sections éditables + réécoute du WAV + Valider. Plus jamais la note
  // brute dans /notes.
  const openCorrection = async () => {
    try {
      const note = await invoke<NoteFile>("open_context_note");
      setResolveSession({
        mode: "context",
        recordingId: recap?.recordingId ?? "",
        noteTitle: recap?.noteTitle ?? null,
        contextPath: note.path,
        sections: parseContextSections(note.body),
      });
      goto("correcting");
      navigate("/resolve");
    } catch (e) {
      console.error("[tour] open_context_note failed:", e);
      fail("Impossible d'ouvrir votre note de contexte — vous pourrez la corriger plus tard depuis les Réglages.");
    }
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
      // Le téléprompteur porte ses propres commandes (spec/13 étape 2) :
      // Commencer / Pause / J'ai terminé, puis Recommencer / Continuer (revue).
      return (
        <>
          <SkipLink onClick={skip} />
          <Teleprompter
            elapsed={elapsed}
            onStart={() => startRecording("mic_only", "context")}
            onStop={stopRecording}
            onDiscarded={() => { /* on reste sur le téléprompteur, prêt à relancer */ }}
            onContinued={() => { navigate("/notes"); goto("visit-notes"); }}
          />
        </>
      );

    case "waiting":
      return (
        <>
          <SkipLink onClick={skip} />
          <PipelineToast />
        </>
      );

    case "ready":
      // Un SEUL bouton (feedback tests) : on force le passage par la vérification.
      return (
        <TourModal
          glow
          title="Alfred vous connaît — mais vérifiez ce qu'il a compris"
          text={
            recap && recap.terms > 0
              ? `Votre contexte est prêt (${recap.sections} section${recap.sections > 1 ? "s" : ""} remplie${recap.sections > 1 ? "s" : ""}) et ${recap.terms} noms propres ont rejoint le glossaire de transcription. Un coup d'œil pour corriger ce qu'il faut ?`
              : "Votre contexte est prêt. Un coup d'œil pour corriger ce qu'il faut ?"
          }
          primary="Revoir / corriger"
          onPrimary={openCorrection}
        />
      );

    case "correcting":
      // L'écran /resolve (mode contexte) est aux commandes ; il renvoie vers
      // « closing » au Valider (voir Resolve.tsx). Rien à afficher par-dessus.
      return null;

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

    default: {
      // Étapes de visite (spec/13 étape 3) — spotlights non bloquants pendant que
      // le pipeline tourne, avec l'indicateur d'état discret en haut à droite.
      const visit = VISIT_STEPS.find((v) => v.step === step);
      if (!visit) return null;
      return (
        <>
          <SkipLink onClick={skip} />
          <PipelineToast />
          <Spotlight target={targets[visit.target]}>
            <SpotlightCard
              title={visit.title}
              text={visit.text}
              onNext={() => {
                const nextDef = VISIT_STEPS.find((v) => v.step === visit.next);
                if (nextDef) navigate(nextDef.route);
                goto(visit.next);
              }}
              nextLabel={visit.next === "waiting" ? "Terminer la visite" : "Suivant"}
            />
          </Spotlight>
        </>
      );
    }
  }
}
