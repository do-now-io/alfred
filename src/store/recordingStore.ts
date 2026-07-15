import { create } from "zustand";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type RecordingStatus =
  | "idle"
  | "recording"
  | "paused"
  | "stopping"
  | "stopped" // revue « prise terminée » (spec/03) — en attente Supprimer/Continuer
  | "processing"
  | "error";

export type RecordingPurpose = "meeting" | "context";

/** Traitements aval cochés au panneau de revue (spec/03/05). */
export interface ProcessSelection {
  transcribe: boolean;
  summary: boolean;
  tasks: boolean;
}

interface RecordingStore {
  status: RecordingStatus;
  durationSeconds: number;
  /** Epoch ms anchor for the live timer. Re-anchored on every backend event so
   *  pauses (whose time the backend excludes) never desync the display. */
  startedAt: number | null;
  /** Live mic RMS level (0..1), from `recording-status-changed` (spec/03 feedback live). */
  volume: number;
  errorMessage: string | null;
  /** La prise en revue « prise terminée » (spec/03), après « Terminer ». */
  reviewRecordingId: string | null;
  reviewPurpose: RecordingPurpose;
  setStatus: (
    status: RecordingStatus,
    durationSeconds: number,
    volume?: number,
    recordingId?: string,
    purpose?: string,
  ) => void;
  setError: (message: string) => void;
  /** `purpose` = "context" starts the guided-tour context recording (spec/13). */
  startRecording: (source?: string, purpose?: string) => Promise<void>;
  /** « Terminer » — arrête et passe en revue ; ne lance PLUS l'aval (spec/03). */
  stopRecording: () => Promise<void>;
  /** « Annuler » pendant la prise — jette le WAV, aucun aval (spec/03). */
  cancelRecording: () => Promise<void>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  /** « Supprimer » / « Recommencer » depuis la revue — jette la prise. */
  discardReview: () => Promise<void>;
  /** « Continuer » depuis la revue — lance seulement les traitements cochés. */
  processReview: (selection: ProcessSelection) => Promise<void>;
  /** Pick an existing WAV and transcribe it through the live pipeline (spec/03). */
  importAudioFile: () => Promise<void>;
}

export const useRecordingStore = create<RecordingStore>((set, get) => ({
  status: "idle",
  durationSeconds: 0,
  startedAt: null,
  volume: 0,
  errorMessage: null,
  reviewRecordingId: null,
  reviewPurpose: "meeting",

  setStatus: (status, durationSeconds, volume, recordingId, purpose) =>
    set((s) => ({
      status,
      durationSeconds,
      errorMessage: null,
      volume: status === "recording" ? (volume ?? s.volume) : 0,
      // Re-anchor on every event: the backend's duration excludes paused time,
      // so deriving from a fixed anchor would drift after a pause.
      startedAt:
        status === "recording"
          ? Date.now() - durationSeconds * 1000
          : status === "paused"
            ? s.startedAt
            : null,
      reviewRecordingId:
        status === "stopped" ? (recordingId ?? s.reviewRecordingId) : status === "idle" ? null : s.reviewRecordingId,
      reviewPurpose:
        status === "stopped" && purpose === "context" ? "context" : status === "stopped" ? "meeting" : s.reviewPurpose,
    })),

  setError: (message) => set({ status: "error", errorMessage: message, startedAt: null, volume: 0 }),

  startRecording: async (source = "mic_only", purpose?: string) => {
    try {
      set({ status: "recording", durationSeconds: 0, startedAt: Date.now(), errorMessage: null, volume: 0, reviewRecordingId: null });
      await invoke("start_recording", { source, purpose });
    } catch (e) {
      set({ status: "error", errorMessage: String(e), startedAt: null, volume: 0 });
    }
  },

  stopRecording: async () => {
    try {
      set({ status: "stopping" });
      await invoke("stop_recording");
      // The backend emits `recording-status-changed { stopped, recording_id }`
      // which lands in setStatus and opens the review panel.
    } catch (e) {
      set({ status: "error", errorMessage: String(e), startedAt: null });
    }
  },

  cancelRecording: async () => {
    try {
      await invoke("cancel_recording");
      set({ status: "idle", durationSeconds: 0, startedAt: null, volume: 0, reviewRecordingId: null });
    } catch (e) {
      set({ status: "error", errorMessage: String(e), startedAt: null });
    }
  },

  pauseRecording: async () => {
    try {
      await invoke("pause_recording");
      set({ status: "paused", volume: 0 });
    } catch (e) {
      set({ status: "error", errorMessage: String(e) });
    }
  },

  resumeRecording: async () => {
    try {
      await invoke("resume_recording");
      set({ status: "recording" });
    } catch (e) {
      set({ status: "error", errorMessage: String(e) });
    }
  },

  discardReview: async () => {
    const id = get().reviewRecordingId;
    if (!id) return;
    try {
      await invoke("discard_recording", { recordingId: id });
      set({ status: "idle", durationSeconds: 0, startedAt: null, volume: 0, reviewRecordingId: null });
    } catch (e) {
      set({ status: "error", errorMessage: String(e) });
    }
  },

  processReview: async ({ transcribe, summary, tasks }) => {
    const id = get().reviewRecordingId;
    if (!id) return;
    try {
      // Dépendance spec/03 : compte-rendu/tâches supposent la transcription.
      const eff = transcribe ? { transcribe, summary, tasks } : { transcribe: false, summary: false, tasks: false };
      await invoke("process_recording", { recordingId: id, ...eff });
      set({
        status: eff.transcribe ? "processing" : "idle",
        startedAt: null,
        volume: 0,
        reviewRecordingId: null,
      });
    } catch (e) {
      set({ status: "error", errorMessage: String(e) });
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
 * Live elapsed seconds for the active recording. While recording, ticks from the
 * event-anchored `startedAt`; while paused, freezes on the backend's last
 * duration (which excludes paused time). Returns 0 otherwise.
 */
export function useRecordingElapsed(): number {
  const status = useRecordingStore((s) => s.status);
  const startedAt = useRecordingStore((s) => s.startedAt);
  const durationSeconds = useRecordingStore((s) => s.durationSeconds);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (status === "paused") {
      setElapsed(durationSeconds);
      return;
    }
    if (status !== "recording" || startedAt == null) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [status, startedAt, durationSeconds]);

  return elapsed;
}
