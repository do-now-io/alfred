import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

/** `recording_id`s ayant une vérification en attente (spec/17 §3/spec/07,
 *  feedback tests) — alimente l'indicateur « à vérifier » sur la note (arbre +
 *  Récents). Rafraîchi par App.tsx sur `pending-clarifications-changed` /
 *  `clarifications-ready` (voir ce fichier pour l'abonnement, unique). */
interface PendingReviewStore {
  ids: Set<string>;
  fetch: () => Promise<void>;
}

export const usePendingReviewStore = create<PendingReviewStore>((set) => ({
  ids: new Set(),
  fetch: async () => {
    try {
      const ids = await invoke<string[]>("list_pending_clarifications");
      set({ ids: new Set(ids) });
    } catch (e) {
      console.error("list_pending_clarifications failed:", e);
    }
  },
}));
