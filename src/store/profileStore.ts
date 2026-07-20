import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// Profil local (spec/10/11, feedback tests) : prénom + avatar stockés EN LOCAL
// (config, pas de compte serveur — cohérent v1, pas de PII, metrics anonymes).
// Remplace le menu profil ambigu du haut-droite (retiré, spec/10). Réutilisé
// dans l'app : assignation de tâche à soi (« @moi », spec/06), reconnaissance
// de l'utilisateur dans les participants (spec/07).

const NAME_KEY = "profile_name";
const AVATAR_KEY = "profile_avatar";

interface ProfileStore {
  name: string;
  /** Data URI (image) ou `null` — pas d'avatar, l'UI retombe sur l'initiale. */
  avatar: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  setName: (name: string) => Promise<void>;
  setAvatar: (avatar: string | null) => Promise<void>;
}

export const useProfileStore = create<ProfileStore>((set, get) => ({
  name: "",
  avatar: null,
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      const [name, avatar] = await Promise.all([
        invoke<string | null>("get_config", { key: NAME_KEY }),
        invoke<string | null>("get_config", { key: AVATAR_KEY }),
      ]);
      set({ name: name ?? "", avatar: avatar || null, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  setName: async (name) => {
    set({ name });
    try { await invoke("set_config", { key: NAME_KEY, value: name }); } catch { /* best-effort */ }
  },

  setAvatar: async (avatar) => {
    set({ avatar });
    try { await invoke("set_config", { key: AVATAR_KEY, value: avatar ?? "" }); } catch { /* best-effort */ }
  },
}));

/** Est-ce que `name` désigne l'utilisateur lui-même (comparaison souple) ? */
export function isSelf(name: string | null | undefined, profileName: string): boolean {
  if (!name || !profileName.trim()) return false;
  return name.trim().toLowerCase() === profileName.trim().toLowerCase();
}
