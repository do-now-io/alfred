import { create } from "zustand";

// Alfred's "butler" status indicator (spec/10) — driven by the real pipeline
// events (recording → transcription → ingestion), wired once in App.tsx.
// Beyond the *state*, the store carries the current **target** ("où Alfred
// travaille", feedback tests) : la note en cours de traitement (point ambre
// dans les listes) et/ou la route à ouvrir quand on clique l'indicateur.

export type AlfredState = "idle" | "recording" | "transcribing" | "thinking" | "tasking";

/** Ce sur quoi Alfred travaille en ce moment (spec/10). */
export interface AlfredTarget {
  /** Chemin absolu de la note traitée (point ambre dans Récents / listes). */
  targetPath?: string;
  /** Route à ouvrir au clic (ex. `/resolve` quand une session est ouverte). */
  targetRoute?: string;
  recordingId?: string;
}

const LABELS: Record<AlfredState, string> = {
  idle: "À votre service",
  recording: "Tout ouïe…",
  transcribing: "Je prends note…",
  thinking: "Je cogite…",
  // Phase `tasks` de l'ingestion (spec/05/10) — brève (1 seul appel IA, c'est
  // l'écriture des tâches) mais honnête : l'utilisateur voit enfin qu'Alfred
  // crée les tâches.
  tasking: "Je note les tâches…",
};

interface AlfredStatusStore {
  state: AlfredState;
  target: AlfredTarget | null;
  set: (state: AlfredState) => void;
  setTarget: (target: AlfredTarget | null) => void;
}

export const useAlfredStatusStore = create<AlfredStatusStore>((set) => ({
  state: "idle",
  target: null,
  set: (state) => set(state === "idle" ? { state, target: null } : { state }),
  setTarget: (target) => set({ target }),
}));

export function alfredStatusLabel(state: AlfredState): string {
  return LABELS[state];
}
