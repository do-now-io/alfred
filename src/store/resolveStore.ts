import { create } from "zustand";
import type { Clarifications } from "../bindings/Clarifications";

/**
 * Une résolution en attente (spec/17 §3) — l'écran `/resolve` est **toujours**
 * présenté après une transcription (réunion ou contexte, spec/13/17, feedback
 * tests) : le compte-rendu/tâches (ou la note de contexte) ne sont écrits
 * qu'après le **Valider** de l'utilisateur, jamais auto-enchaînés. **Un seul
 * écran** pour les deux cas (spec/13 étape 5 : « même composant, même route,
 * mêmes interactions ») — seul le **contenu injecté** diffère :
 * - `mode: "meeting"` — `text` = la transcription brute ; `clarifications`
 *   peut porter des propositions (corrections, tâche sans responsable…) ;
 *   Valider → `finalize_ingestion` (écrit compte-rendu + tâches).
 * - `mode: "context"` — `text` = la note de contexte déjà structurée par
 *   Claude (visite guidée, spec/13) ; `clarifications` toujours vide (rien à
 *   proposer, juste à relire) ; Valider → `update_note_file` sur `contextPath`.
 */
export interface ResolveSession {
  mode: "meeting" | "context";
  recordingId: string;
  /** Titre de la note brute de transcription — clé de `read_recording_wav`. */
  noteTitle: string;
  /** Le texte éditable : transcription (réunion) ou corps structuré (contexte). */
  text: string;
  clarifications: Clarifications;
  /** Traitements aval cochés au panneau de revue (spec/03/05) — ignorés en mode contexte. */
  summary: boolean;
  tasks: boolean;
  /** Mode contexte uniquement : chemin de `Contexte Alfred.md` à réécrire. */
  contextPath?: string;
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
