import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { MdClose, MdMic } from "react-icons/md";
import { useTourStore, type TourStep } from "../../store/tourStore";
import { useRecordingStore, useRecordingElapsed } from "../../store/recordingStore";
import { useResolveStore } from "../../store/resolveStore";
import { useAlfredStatusStore } from "../../store/alfredStatusStore";
import type { NoteFile } from "../../bindings/NoteFile";
import { Spotlight } from "./Spotlight";
import Teleprompter from "./Teleprompter";
import AlfredAvatar from "../AlfredAvatar";
import { useT } from "../../i18n";

// The guided tour (spec/13): a real, event-driven walkthrough right after
// onboarding. The first recording IS the creation of `Contexte Alfred.md` — the
// user introduces themselves aloud (teleprompter with pause + review controls),
// then a short "I'm on it, I'll come back to you" card (`processing`) sets
// expectations before the visit starts. While the pipeline runs, the tour walks
// the app (Notes → Tâches → Graphe → Alfred & enregistrer). As soon as the
// context is ready, a pop-up interrupts the visit — single « Revoir / corriger »
// button → /resolve in context mode — then the closing card. Every step reacts
// to the real backend pipeline.

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
  const t = useT();
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
      <MdClose size={14} /> {t("tour.skipVisit")}
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
        <AlfredAvatar size={56} />
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
  title, text, onNext, nextLabel,
}: { title?: string; text: string; onNext?: () => void; nextLabel?: string }) {
  const t = useT();
  return (
    <div className="card" style={{
      padding: "16px 18px", boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
      display: "flex", flexDirection: "column", gap: 10,
    }}>
      {title && <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{title}</div>}
      <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text-secondary)" }}>{text}</div>
      {onNext && (
        <button onClick={onNext} style={{ ...primaryBtn(), alignSelf: "flex-end", padding: "6px 14px" }}>
          {nextLabel ?? t("tour.visit.next")}
        </button>
      )}
    </div>
  );
}

/** L'indicateur d'état discret pendant la visite (spec/13 étape 3). */
function PipelineToast() {
  const t = useT();
  const butler = useAlfredStatusStore((s) => s.state);
  const progress = useAlfredStatusStore((s) => s.progress);
  if (butler === "transcribing") {
    // Progression réelle (spec/04, feedback tests).
    const pct = progress != null ? ` (${progress} %)` : "";
    return <TourToast icon="⏳" text={t("tour.toast.transcribing", { pct })} />;
  }
  return <TourToast icon="🗂️" text={t("tour.toast.sorting")} />;
}

interface VisitStepDef {
  step: TourStep; next: TourStep; target: string; route: string;
  title: string; text: string;
}

// The app-visit steps (spec/13 étape 3) — spotlight target id + copy + where to
// be. Built from `t()` inside the component (not a module-level constant) so
// the copy re-renders on language change (spec/21).
function buildVisitSteps(t: ReturnType<typeof useT>): VisitStepDef[] {
  return [
    {
      step: "visit-notes", next: "visit-tasks", target: "nav-notes", route: "/notes",
      title: t("tour.visit.notes.title"),
      text: t("tour.visit.notes.text"),
    },
    {
      step: "visit-tasks", next: "visit-graph", target: "nav-tasks", route: "/tasks",
      title: t("tour.visit.tasks.title"),
      text: t("tour.visit.tasks.text"),
    },
    {
      step: "visit-graph", next: "visit-chat", target: "nav-graph", route: "/graph",
      title: t("tour.visit.graph.title"),
      text: t("tour.visit.graph.text"),
    },
    {
      step: "visit-chat", next: "waiting", target: "nav-chat", route: "/",
      title: t("tour.visit.chat.title"),
      text: t("tour.visit.chat.text"),
    },
  ];
}

export default function GuidedTour() {
  const t = useT();
  const { active, step, error, targets, recap, contextReady, goto, setRecap, fail, skip, finish } = useTourStore();
  const navigate = useNavigate();
  const startRecording = useRecordingStore((s) => s.startRecording);
  const stopRecording = useRecordingStore((s) => s.stopRecording);
  const setResolveSession = useResolveStore((s) => s.setSession);
  const elapsed = useRecordingElapsed();
  const VISIT_STEPS = buildVisitSteps(t);

  useEffect(() => {
    if (!active) return;
    const unsubs: Array<() => void> = [];

    listen<{ status: string }>("recording-status-changed", (e) => {
      if (e.payload.status === "error" && step === "record") {
        fail(t("tour.error.recordingFailed"));
      }
    }).then((fn) => unsubs.push(fn));

    // « Contexte prêt » (spec/13 étape 4, feedback tests) : l'événement ne doit
    // PAS interrompre la visite — il est MÉMORISÉ (drapeau + récap via setRecap).
    // La pop-up ne s'affiche qu'à la fin de la dernière étape de découverte
    // (immédiatement si le drapeau est déjà levé), ou depuis « waiting » si la
    // visite est déjà finie quand l'événement arrive.
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
          // Seul cas d'affichage immédiat : la visite est déjà terminée et on
          // attendait sur l'indicateur d'état.
          if (step === "waiting") goto("ready");
        } else {
          fail(t("tour.error.contextFailed"));
        }
      }
    ).then((fn) => unsubs.push(fn));

    return () => unsubs.forEach((fn) => fn());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, step, goto, setRecap, fail]);

  if (!active) return null;

  if (error) {
    return <TourModal title={t("tour.error.title")} text={error} primary={t("tour.error.continueBtn")} onPrimary={() => goto("closing")} />;
  }

  // « Revoir / corriger » (spec/13 étape 5) : ouvre /resolve — MÊME écran que la
  // vérification d'un enregistrement de réunion (texte éditable + réécoute WAV +
  // Valider), pas de variante spécifique à l'onboarding. Seul le contenu
  // injecté diffère (le corps déjà structuré de Contexte Alfred.md). Plus
  // jamais la note brute ouverte dans /notes.
  const openCorrection = async () => {
    try {
      const note = await invoke<NoteFile>("open_context_note");
      setResolveSession({
        mode: "context",
        recordingId: recap?.recordingId ?? "",
        noteTitle: recap?.noteTitle ?? "",
        contextPath: note.path,
        text: note.body,
        clarifications: { transcription_fixes: [], unassigned_tasks: [], unclear_sentences: [], context_additions: [] },
        summary: false,
        tasks: false,
      });
      goto("correcting");
      navigate("/resolve");
    } catch (e) {
      console.error("[tour] open_context_note failed:", e);
      fail(t("tour.error.openContextFailed"));
    }
  };

  switch (step) {
    case "intro":
      return (
        <TourModal
          title={t("tour.intro.title")}
          text={t("tour.intro.text")}
          primary={t("tour.intro.primary")}
          onPrimary={() => goto("record")}
          secondary={t("tour.intro.secondary")}
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
            onContinued={() => goto("processing")}
          />
        </>
      );

    case "processing":
      // Pose les attentes avant la visite (demande utilisateur) : Alfred
      // annonce qu'il travaille et qu'il reviendra, plutôt que de basculer
      // silencieusement sur Notes avec pour seul indice le petit toast
      // d'état (`PipelineToast`, qui reste affiché pendant la visite).
      return (
        <TourModal
          title={t("tour.processing.title")}
          text={t("tour.processing.text")}
          primary={t("tour.processing.primary")}
          onPrimary={() => goto("status-dot")}
        />
      );

    case "status-dot":
      // Explique le point d'état de la sidebar (demande utilisateur) avant
      // d'entamer la visite — pour qu'il soit reconnaissable ensuite, y
      // compris pendant que le contexte finit de se construire en arrière-plan.
      return (
        <>
          <SkipLink onClick={skip} />
          <PipelineToast />
          <Spotlight target={targets["alfred-status"]}>
            <SpotlightCard
              title={t("tour.statusDot.title")}
              text={t("tour.statusDot.text")}
              onNext={() => { navigate("/notes"); goto("visit-notes"); }}
              nextLabel={t("tour.visit.next")}
            />
          </Spotlight>
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
          title={t("tour.ready.title")}
          text={
            recap && recap.terms > 0
              ? t("tour.ready.recap", {
                  sections: recap.sections,
                  sectionWord: recap.sections > 1 ? t("tour.ready.sections") : t("tour.ready.section"),
                  terms: recap.terms,
                  termsSuffix: recap.terms > 1 ? "s" : "",
                })
              : t("tour.ready.noRecap")
          }
          primary={t("tour.ready.primary")}
          onPrimary={openCorrection}
        />
      );

    case "correcting":
      // L'écran /resolve (mode contexte) est aux commandes ; il renvoie vers
      // « closing » au Valider (voir Resolve.tsx). Rien à afficher par-dessus.
      return null;

    case "closing":
      return (
        <div style={{
          position: "fixed", inset: 0, zIndex: 2200,
          background: "rgba(0,0,0,0.55)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div className="card" style={{
            width: "100%", maxWidth: 440, padding: "36px 32px 28px", margin: 16,
            display: "flex", flexDirection: "column", alignItems: "center", gap: 16,
            textAlign: "center",
            boxShadow: `0 0 60px -8px ${ACCENT}, 0 12px 48px rgba(0,0,0,0.3)`,
          }}>
            <AlfredAvatar size={56} />
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "var(--text-primary)" }}>
              {t("tour.closing.title")}
            </h2>
            <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, color: "var(--text-secondary)" }}>
              {t("tour.closing.text")}
            </p>
            {/* Aperçu de /recording (spec/03) : ce qu'on retrouvera au prochain
                enregistrement, plutôt qu'un écran générique déconnecté (spec/13). */}
            <div style={{
              border: "1px solid var(--border)", borderRadius: 12, padding: "14px 18px",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 8, width: "100%",
            }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {t("tour.closing.previewHint")}
              </div>
              <div style={{
                background: ACCENT, color: "#fff", borderRadius: 10, padding: "9px 20px",
                fontSize: 13.5, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 8,
              }}>
                <MdMic size={16} /> {t("recording.guide.startRecording")}
              </div>
            </div>
            <button onClick={finish} style={primaryBtn()}>{t("tour.closing.primary")}</button>
          </div>
        </div>
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
                if (visit.next === "waiting") {
                  // Fin de la dernière étape de découverte (spec/13) : la pop-up
                  // « Contexte prêt » s'affiche MAINTENANT si l'événement est
                  // arrivé pendant la visite (mémorisé), sinon on attend dessus.
                  goto(contextReady ? "ready" : "waiting");
                  return;
                }
                const nextDef = VISIT_STEPS.find((v) => v.step === visit.next);
                if (nextDef) navigate(nextDef.route);
                goto(visit.next);
              }}
              nextLabel={visit.next === "waiting" ? t("tour.visit.finishVisit") : t("tour.visit.next")}
            />
          </Spotlight>
        </>
      );
    }
  }
}
