import { create } from "zustand";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type RecordingStatus = "idle" | "recording" | "stopping" | "processing" | "error";

interface RecordingStore {
  status: RecordingStatus;
  durationSeconds: number;
  /** Epoch ms when the current recording began — survives view changes so the
   *  timer stays accurate no matter which component (re)mounts. */
  startedAt: number | null;
  /** Live mic RMS level (0..1), from `recording-status-changed` (spec/03 feedback live). */
  volume: number;
  errorMessage: string | null;
  setStatus: (status: RecordingStatus, durationSeconds: number, volume?: number) => void;
  setError: (message: string) => void;
  /** `purpose` = "context" starts the guided-tour context recording (spec/13). */
  startRecording: (source?: string, purpose?: string) => Promise<void>;
  stopRecording: () => Promise<void>;
  /** Pick an existing WAV and transcribe it through the live pipeline (spec/03). */
  importAudioFile: () => Promise<void>;
}

export const useRecordingStore = create<RecordingStore>((set) => ({
  status: "idle",
  durationSeconds: 0,
  startedAt: null,
  volume: 0,
  errorMessage: null,

  setStatus: (status, durationSeconds, volume) =>
    set((s) => ({
      status,
      durationSeconds,
      errorMessage: null,
      volume: status === "recording" ? (volume ?? s.volume) : 0,
      // Anchor the start time once when recording begins and keep it across
      // subsequent status events; clear it when we return to idle/error.
      startedAt:
        status === "recording"
          ? s.startedAt ?? Date.now() - durationSeconds * 1000
          : status === "idle" || status === "error"
            ? null
            : s.startedAt,
    })),

  setError: (message) => set({ status: "error", errorMessage: message, startedAt: null, volume: 0 }),

  startRecording: async (source = "mic_only", purpose?: string) => {
    try {
      set({ status: "recording", durationSeconds: 0, startedAt: Date.now(), errorMessage: null, volume: 0 });
      await invoke("start_recording", { source, purpose });
    } catch (e) {
      set({ status: "error", errorMessage: String(e), startedAt: null, volume: 0 });
    }
  },

  stopRecording: async () => {
    try {
      set({ status: "stopping" });
      await invoke("stop_recording");
    } catch (e) {
      set({ status: "error", errorMessage: String(e), startedAt: null });
    }
  },

  importAudioFile: async () => {
    try {
      // Backend opens the file picker; null → user cancelled (leave state as-is).
      // On success it also emits `recording-status-changed { processing }`, so the
      // butler label lights up on its own — we just mirror it for instant feedback.
      const id = await invoke<string | null>("import_audio_file");
      if (id) set({ status: "processing", startedAt: null, volume: 0, errorMessage: null });
    } catch (e) {
      set({ status: "error", errorMessage: String(e), startedAt: null, volume: 0 });
    }
  },
}));

/**
 * Live elapsed seconds for the active recording, derived from `startedAt` rather
 * than a local counter — so the value is correct regardless of when or where the
 * consuming component mounted (e.g. after navigating away and back). Ticks once
 * per second while recording; returns 0 otherwise.
 */
export function useRecordingElapsed(): number {
  const status = useRecordingStore((s) => s.status);
  const startedAt = useRecordingStore((s) => s.startedAt);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (status !== "recording" || startedAt == null) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [status, startedAt]);

  return elapsed;
}
