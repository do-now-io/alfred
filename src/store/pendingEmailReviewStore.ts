import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

/** Badge de notification (spec/24 §5) — nombre d'items `pending` dans
 *  `pending_email_reviews`. Rafraîchi au démarrage de l'app et sur
 *  l'événement `pending-email-reviews-changed` (émis par `sync_emails`/
 *  `resolve_email_reviews`, back-end). */
interface PendingEmailReviewStore {
  count: number;
  fetch: () => Promise<void>;
}

export const usePendingEmailReviewStore = create<PendingEmailReviewStore>((set) => ({
  count: 0,
  fetch: async () => {
    try {
      const count = await invoke<number>("get_pending_email_review_count");
      set({ count });
    } catch (e) {
      console.error("get_pending_email_review_count failed:", e);
    }
  },
}));
