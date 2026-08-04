import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Mise à jour automatique (spec/27) : check() une fois au démarrage (App.tsx,
// fire-and-forget, échec réseau silencieux) + bouton manuel dans Réglages.
// Aucune installation sans clic explicite — `installUpdate` n'est jamais
// appelé automatiquement.

export type UpdateCheckStatus = "idle" | "checking" | "up_to_date" | "available" | "error";

interface UpdateInfo {
  version: string;
  body: string | null;
}

interface UpdateStore {
  status: UpdateCheckStatus;
  info: UpdateInfo | null;
  installing: boolean;
  /** % de téléchargement, `null` tant que la taille totale n'est pas connue. */
  progress: number | null;
  error: string | null;
  /** Bandeau masqué par l'utilisateur pour cette session (spec/27 — non intrusif). */
  dismissed: boolean;
  checkForUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  dismiss: () => void;
}

// Handle Tauri retourné par `check()` — pas dans le store (non sérialisable/pas
// besoin de re-render), utilisé uniquement par `installUpdate`.
let pendingUpdate: Update | null = null;

export const useUpdateStore = create<UpdateStore>((set) => ({
  status: "idle",
  info: null,
  installing: false,
  progress: null,
  error: null,
  dismissed: false,

  checkForUpdate: async () => {
    set({ status: "checking", error: null });
    try {
      const update = await check();
      if (update?.available) {
        pendingUpdate = update;
        set({
          status: "available",
          info: { version: update.version, body: update.body ?? null },
          dismissed: false,
        });
      } else {
        pendingUpdate = null;
        set({ status: "up_to_date", info: null });
      }
    } catch (e) {
      pendingUpdate = null;
      set({ status: "error", error: String(e) });
    }
  },

  installUpdate: async () => {
    if (!pendingUpdate) return;
    set({ installing: true, progress: null, error: null });
    let total = 0;
    let downloaded = 0;
    try {
      await pendingUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          set({ progress: total > 0 ? Math.round((downloaded / total) * 100) : null });
        }
      });
      await relaunch();
    } catch (e) {
      set({ installing: false, error: String(e) });
    }
  },

  dismiss: () => set({ dismissed: true }),
}));
