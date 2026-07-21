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

// Libellés traduits dans src/i18n/catalogs/nav.ts (clé `nav.butler.*`, spec/21) —
// `alfredStatusLabel` prend le traducteur en paramètre plutôt que d'importer
// directement les chaînes ici (store hors composant, pas de hook).
const STATE_KEYS: Record<AlfredState, string> = {
  idle: "nav.butler.idle",
  recording: "nav.butler.recording",
  transcribing: "nav.butler.transcribing",
  thinking: "nav.butler.thinking",
  // Phase `tasks` de l'ingestion (spec/05/10) — brève (1 seul appel IA, c'est
  // l'écriture des tâches) mais honnête : l'utilisateur voit enfin qu'Alfred
  // crée les tâches.
  tasking: "nav.butler.tasking",
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
 *  événement de progression reçu (spec/04/10, feedback tests). `t` = `useT()`
 *  de l'appelant (spec/21 — le store n'est pas un composant, pas de hook ici). */
export function alfredStatusLabel(state: AlfredState, progress: number | null | undefined, t: (key: string) => string): string {
  const base = t(STATE_KEYS[state]);
  if (state === "transcribing" && progress != null) return `${base} ${progress} %`;
  return base;
}
