import { create } from "zustand";
import type { Clarifications } from "../bindings/Clarifications";

/**
 * A pending "augmented ingestion" resolution (spec/17 §3): Claude found things
 * worth validating before writing the compte-rendu. Populated from the
 * `clarifications-ready` backend event; consumed by the /resolve screen. Only
 * ever fires when the `augmented_ingestion` flag is on.
 */
export interface ResolveSession {
  recordingId: string;
  noteTitle: string;
  /** The raw transcription — the starting point the user corrects. */
  text: string;
  clarifications: Clarifications;
}

interface ResolveStore {
  session: ResolveSession | null;
  setSession: (s: ResolveSession) => void;
  clear: () => void;
}

export const useResolveStore = create<ResolveStore>((set) => ({
  session: null,
  setSession: (session) => set({ session }),
  clear: () => set({ session: null }),
}));
