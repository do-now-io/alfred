import { create } from "zustand";
import type { Clarifications } from "../bindings/Clarifications";

/**
 * A pending "augmented ingestion" resolution (spec/17 §3): Claude found things
 * worth validating before writing the compte-rendu. Populated from the
 * `clarifications-ready` backend event; consumed by the /resolve screen. Only
 * ever fires when the `augmented_ingestion` flag is on.
 */
export interface ResolveSession {
  mode: "meeting";
  recordingId: string;
  noteTitle: string;
  /** The raw transcription — the starting point the user corrects. */
  text: string;
  clarifications: Clarifications;
  /** Traitements aval cochés au panneau de revue (spec/03/05) — honorés à la finalisation. */
  summary: boolean;
  tasks: boolean;
}

/**
 * Correction du contexte (spec/13 étape 5) : l'écran /resolve en MODE CONTEXTE —
 * les 4 sections de `Contexte Alfred.md` éditables + réécoute du WAV + Valider.
 */
export interface ContextResolveSession {
  mode: "context";
  recordingId: string;
  /** Titre de la note brute de transcription — clé de `read_recording_wav`. */
  noteTitle: string | null;
  /** Chemin absolu de `Contexte Alfred.md` (réécrite au Valider). */
  contextPath: string;
  sections: { entreprise: string; equipe: string; vocabulaire: string; projets: string };
}

export type AnyResolveSession = ResolveSession | ContextResolveSession;

interface ResolveStore {
  session: AnyResolveSession | null;
  setSession: (s: AnyResolveSession) => void;
  clear: () => void;
}

export const useResolveStore = create<ResolveStore>((set) => ({
  session: null,
  setSession: (session) => set({ session }),
  clear: () => set({ session: null }),
}));
