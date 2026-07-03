import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Suggestion } from "../bindings/Suggestion";

interface SuggestionStore {
  suggestions: Suggestion[];
  fetchSuggestions: () => Promise<void>;
  acceptSuggestion: (id: string) => Promise<void>;
  dismissSuggestion: (id: string) => Promise<void>;
}

export const useSuggestionStore = create<SuggestionStore>((set, get) => ({
  suggestions: [],

  fetchSuggestions: async () => {
    try {
      const suggestions = await invoke<Suggestion[]>("get_suggestions");
      set({ suggestions });
    } catch (e) {
      console.error("Failed to fetch suggestions:", e);
    }
  },

  acceptSuggestion: async (id) => {
    try {
      await invoke("accept_suggestion", { id });
      set({ suggestions: get().suggestions.filter((s) => s.id !== id) });
    } catch (e) {
      console.error("Failed to accept suggestion:", e);
    }
  },

  dismissSuggestion: async (id) => {
    set({ suggestions: get().suggestions.filter((s) => s.id !== id) });
    try {
      await invoke("dismiss_suggestion", { id });
    } catch (e) {
      console.error("Failed to dismiss suggestion:", e);
      get().fetchSuggestions();
    }
  },
}));
