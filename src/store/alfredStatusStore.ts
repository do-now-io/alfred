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
  /** % de progression pendant `transcribing` (spec/04, feedback tests) — `null`
   *  hors transcription ou avant le premier événement `transcription-progress`. */
  progress: number | null;
  set: (state: AlfredState) => void;
  setTarget: (target: AlfredTarget | null) => void;
  setProgress: (percent: number | null) => void;
}

export const useAlfredStatusStore = create<AlfredStatusStore>((set) => ({
  state: "idle",
  target: null,
  progress: null,
  // Chaque transition d'état repart d'un % vierge — `setProgress` le repeuple
  // au fil des événements `transcription-progress` pendant la phase en cours.
  set: (state) => set(state === "idle" ? { state, target: null, progress: null } : { state, progress: null }),
  setTarget: (target) => set({ target }),
  setProgress: (percent) => set({ progress: percent }),
}));

/** `{n} %` ajouté au libellé pendant la transcription, une fois le premier
 *  événement de progression reçu (spec/04/10, feedback tests). */
export function alfredStatusLabel(state: AlfredState, progress?: number | null): string {
  const base = LABELS[state];
  if (state === "transcribing" && progress != null) return `${base} ${progress} %`;
  return base;
}
