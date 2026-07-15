import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// Guided tour (spec/13): a real, event-driven walkthrough right after onboarding.
// The first recording IS the creation of `Contexte Alfred.md` — the user
// introduces themselves aloud (teleprompter, with pause/review controls), then,
// while the transcription runs, the tour walks the app (Notes → Tâches → Graphe →
// Alfred & enregistrer). As soon as `context-status-changed: done` fires, a
// pop-up interrupts the visit: « Alfred vous connaît — vérifiez » with a single
// « Revoir / corriger » button opening /resolve in context mode. After
// validation → closing card. Never a simulation.

export type TourStep =
  | "intro"
  | "record" // teleprompter: start / pause / review (Recommencer / Continuer)
  | "visit-notes" // app visit while the pipeline runs (spec/13 étape 3)
  | "visit-tasks"
  | "visit-graph"
  | "visit-chat"
  | "waiting" // visit finished but the context isn't ready yet
  | "ready" // context built — pop-up, single « Revoir / corriger » button
  | "correcting" // /resolve open in context mode; tour waits for Valider
  | "closing";

/** Recap payload of `context-status-changed: done` (spec/13 étape 4). */
export interface ContextRecap {
  sections: number;
  terms: number;
  recordingId: string;
  /** Raw-transcription note title — for WAV re-listen in /resolve. */
  noteTitle: string | null;
}

interface TourState {
  active: boolean;
  step: TourStep;
  error: string | null;
  recap: ContextRecap | null;
  /** DOM targets the spotlight/toasts anchor to, keyed by a stable id. */
  targets: Record<string, HTMLElement | null>;
  registerTarget: (id: string, el: HTMLElement | null) => void;
  start: () => void;
  goto: (step: TourStep) => void;
  setRecap: (recap: ContextRecap) => void;
  fail: (message: string) => void;
  skip: () => void;
  finish: () => void;
}

const persistCompleted = () => {
  invoke("set_config", { key: "tour_completed", value: "true" }).catch(() => {});
};

export const useTourStore = create<TourState>((set) => ({
  active: false,
  step: "intro",
  error: null,
  recap: null,
  targets: {},

  registerTarget: (id, el) =>
    set((s) => (s.targets[id] === el ? s : { targets: { ...s.targets, [id]: el } })),

  start: () => set({ active: true, step: "intro", error: null, recap: null }),
  goto: (step) => set({ step, error: null }),
  setRecap: (recap) => set({ recap }),
  fail: (message) => set({ error: message }),

  // Skipping still marks the tour as seen — "Revoir la visite guidée" (Réglages)
  // is the only way back in, so we never nag a user who said no thanks.
  skip: () => {
    set({ active: false });
    persistCompleted();
  },
  finish: () => {
    set({ active: false });
    persistCompleted();
  },
}));

/** Ref callback to attach to any element the tour may spotlight. */
export function useTourTarget(id: string) {
  const registerTarget = useTourStore((s) => s.registerTarget);
  return (el: HTMLElement | null) => registerTarget(id, el);
}
