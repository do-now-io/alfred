import { create } from "zustand";

/** Petit toast global (spec/23) — pour un feedback visible quand un lien
 *  interne (`[[wikilink]]`/`task:`) ne trouve pas sa cible, plutôt qu'un clic
 *  mort silencieux. Pas de file : un nouveau message remplace l'ancien. */
interface ToastStore {
  message: string | null;
  show: (message: string) => void;
  hide: () => void;
}

const AUTO_HIDE_MS = 3500;

export const useToastStore = create<ToastStore>((set) => ({
  message: null,
  show: (message) => {
    set({ message });
    setTimeout(() => {
      set((s) => (s.message === message ? { message: null } : s));
    }, AUTO_HIDE_MS);
  },
  hide: () => set({ message: null }),
}));
