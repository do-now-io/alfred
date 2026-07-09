import { create } from "zustand";
import type { LiveSessionStarted } from "../bindings/LiveSessionStarted";

// Session de transcription live en cours (spec/16). Alimenté par les événements
// `live-session-started` / `live-session-ended` (listeners dans AppInner).
// `notePath` survit à la fin de session le temps que l'écran Notes se stabilise.

interface LiveSessionStore {
  active: boolean;
  recordingId: string | null;
  notePath: string | null;
  noteTitle: string | null;

  start: (s: LiveSessionStarted) => void;
  end: () => void;
}

export const useLiveSessionStore = create<LiveSessionStore>((set) => ({
  active: false,
  recordingId: null,
  notePath: null,
  noteTitle: null,

  start: (s) =>
    set({
      active: true,
      recordingId: s.recording_id,
      notePath: s.note_path,
      noteTitle: s.note_title,
    }),

  end: () => set({ active: false, recordingId: null }),
}));
