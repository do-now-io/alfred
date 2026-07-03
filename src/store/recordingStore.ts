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
  errorMessage: string | null;
  setStatus: (status: RecordingStatus, durationSeconds: number) => void;
  setError: (message: string) => void;
  startRecording: (source?: string) => Promise<void>;
  stopRecording: () => Promise<void>;
}

export const useRecordingStore = create<RecordingStore>((set) => ({
  status: "idle",
  durationSeconds: 0,
  startedAt: null,
  errorMessage: null,

  setStatus: (status, durationSeconds) =>
    set((s) => ({
      status,
      durationSeconds,
      errorMessage: null,
      // Anchor the start time once when recording begins and keep it across
      // subsequent status events; clear it when we return to idle/error.
      startedAt:
        status === "recording"
          ? s.startedAt ?? Date.now() - durationSeconds * 1000
          : status === "idle" || status === "error"
            ? null
            : s.startedAt,
    })),

  setError: (message) => set({ status: "error", errorMessage: message, startedAt: null }),

  startRecording: async (source = "mic_only") => {
    try {
      set({ status: "recording", durationSeconds: 0, startedAt: Date.now(), errorMessage: null });
      await invoke("start_recording", { source });
    } catch (e) {
      set({ status: "error", errorMessage: String(e), startedAt: null });
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
