import { create } from "zustand";

// Alfred's "butler" status indicator (spec/10) — driven by the real pipeline
// events (recording → transcription → ingestion), wired once in App.tsx.

export type AlfredState = "idle" | "recording" | "transcribing" | "thinking";

const LABELS: Record<AlfredState, string> = {
  idle: "À votre service",
  recording: "Tout ouïe…",
  transcribing: "Je prends note…",
  thinking: "Je cogite…",
};

interface AlfredStatusStore {
  state: AlfredState;
  set: (state: AlfredState) => void;
}

export const useAlfredStatusStore = create<AlfredStatusStore>((set) => ({
  state: "idle",
  set: (state) => set({ state }),
}));

export function alfredStatusLabel(state: AlfredState): string {
  return LABELS[state];
}
