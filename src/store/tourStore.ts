import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// Guided tour (spec/13): a real, event-driven walkthrough right after onboarding.
// The first recording IS the creation of `Contexte Alfred.md` — the user
// introduces themselves aloud (teleprompter), Alfred transcribes, structures the
// context note and derives the glossary, then answers a question about it.
// Never a simulation.

export type TourStep =
  | "intro"
  | "record" // teleprompter + start
  | "recording" // speaking (teleprompter stays)
  | "transcribing"
  | "structuring" // Claude builds the context note + glossary
  | "ready" // context built — recap
  | "ask"
  | "closing";

interface TourState {
  active: boolean;
  step: TourStep;
  error: string | null;
  /** DOM targets the spotlight/toasts anchor to, keyed by a stable id. */
  targets: Record<string, HTMLElement | null>;
  registerTarget: (id: string, el: HTMLElement | null) => void;
  start: () => void;
  goto: (step: TourStep) => void;
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
  targets: {},

  registerTarget: (id, el) =>
    set((s) => (s.targets[id] === el ? s : { targets: { ...s.targets, [id]: el } })),

  start: () => set({ active: true, step: "intro", error: null }),
  goto: (step) => set({ step, error: null }),
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
