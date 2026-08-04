import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Catalog, Lang } from "./types";

import common from "./catalogs/common";
import nav from "./catalogs/nav";
import onboarding from "./catalogs/onboarding";
import tour from "./catalogs/tour";
import settings from "./catalogs/settings";
import dashboard from "./catalogs/dashboard";
import chat from "./catalogs/chat";
import notes from "./catalogs/notes";
import tasks from "./catalogs/tasks";
import recording from "./catalogs/recording";
import resolve from "./catalogs/resolve";
import resolveEmails from "./catalogs/resolveEmails";
import feedback from "./catalogs/feedback";
import graph from "./catalogs/graph";
import errors from "./catalogs/errors";
import calendar from "./catalogs/calendar";

// Un module par domaine (spec/21) — évite qu'une traduction de tout l'app en
// une passe fasse collision sur un unique gros fichier. Chaque module
// exporte { fr, en } pour SON namespace ; on les assemble ici.
const NAMESPACES = {
  common, nav, onboarding, tour, settings, dashboard, chat, notes, tasks,
  recording, resolve, resolveEmails, feedback, graph, errors, calendar,
};

function buildCatalog(lang: Lang): Catalog {
  const out: Catalog = {};
  for (const [ns, mod] of Object.entries(NAMESPACES)) {
    out[ns] = (mod as Record<Lang, Catalog>)[lang];
  }
  return out;
}

const CATALOGS: Record<Lang, Catalog> = { fr: buildCatalog("fr"), en: buildCatalog("en") };

function resolvePath(catalog: Catalog, path: string): string | undefined {
  let node: Catalog[string] = catalog;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Catalog)[part];
    if (node === undefined) return undefined;
  }
  return typeof node === "string" ? node : undefined;
}

/** Langue système au 1er lancement (spec/21) — pré-sélection de l'étape 0 de
 *  l'onboarding : langue système si `fr`/`en`, sinon `en` (pas `fr` par
 *  défaut ici — un système dans une 3e langue a plus de chances de lire
 *  l'anglais que le français). */
export function detectSystemLang(): Lang {
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  return nav?.slice(0, 2).toLowerCase() === "fr" ? "fr" : "en";
}

interface I18nStore {
  lang: Lang;
  ready: boolean;
  setLang: (l: Lang) => void;
  init: () => Promise<void>;
}

export const useI18nStore = create<I18nStore>((set) => ({
  // Défaut `fr` (spec/21) tant que la config n'a pas été lue — l'app était
  // 100% française jusqu'ici, un install existant sans `app_language` reste
  // en français plutôt que de basculer en anglais sous ses pieds.
  lang: "fr",
  ready: false,
  setLang: (l) => {
    set({ lang: l });
    invoke("set_config", { key: "app_language", value: l }).catch(() => {});
  },
  init: async () => {
    const v = await invoke<string | null>("get_config", { key: "app_language" }).catch(() => null);
    set({ lang: v === "en" ? "en" : "fr", ready: true });
  },
}));

/** `t("onboarding.welcome.title")` — re-render automatique au changement de
 *  langue (souscrit au store). Clé introuvable → repli FR puis la clé
 *  elle-même (jamais un écran vide). `vars` interpole `{nom}` dans la chaîne. */
export function useT() {
  const lang = useI18nStore((s) => s.lang);
  return (key: string, vars?: Record<string, string | number>) => {
    let str = resolvePath(CATALOGS[lang], key) ?? resolvePath(CATALOGS.fr, key) ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) str = str.split(`{${k}}`).join(String(v));
    }
    return str;
  };
}

/** Variante non-hook pour les stores/utilitaires hors composant React (ex.
 *  `alfredStatusStore`) — lit la langue courante sans s'abonner au re-render. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const lang = useI18nStore.getState().lang;
  let str = resolvePath(CATALOGS[lang], key) ?? resolvePath(CATALOGS.fr, key) ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) str = str.split(`{${k}}`).join(String(v));
  }
  return str;
}

export type { Lang };
