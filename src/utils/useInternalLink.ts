import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useNotesStore } from "../store/notesStore";
import { useToastStore } from "../store/toastStore";
import { useT } from "../i18n";

/** Gestionnaire de lien interne UNIQUE (spec/23) — remplace le câblage dupliqué
 *  qui existait dans `Dashboard.tsx`/`ChatPanel.tsx`/`TaskSheet.tsx`. Prend un
 *  href complet avec son schéma :
 *  - `wikilink:<ref>` → résout par nom de fichier (`openNoteByRef`) → Notes.
 *  - `task:<ref>` → `/tasks?focus=<ref>` (Tasks.tsx fait le scroll + halo, et
 *    le toast « introuvable » si aucune tâche ne correspond une fois chargée).
 *  - `http(s)://` → ouverture externe (`plugin-shell`).
 *  - tout le reste → toast « lien non reconnu / introuvable » (spec/23 : plus
 *    jamais un clic mort silencieux). */
export function useInternalLink() {
  const navigate = useNavigate();
  const openNoteByRef = useNotesStore((s) => s.openNoteByRef);
  const showToast = useToastStore((s) => s.show);
  const t = useT();

  return useCallback(
    async (href: string) => {
      if (href.startsWith("wikilink:")) {
        const ref = decodeURIComponent(href.slice("wikilink:".length));
        const ok = await openNoteByRef(ref);
        if (ok) navigate("/notes");
        else showToast(t("common.linkNotFound"));
        return;
      }
      if (href.startsWith("task:")) {
        const ref = decodeURIComponent(href.slice("task:".length));
        navigate(`/tasks?focus=${encodeURIComponent(ref)}`);
        return;
      }
      if (/^https?:\/\//.test(href)) {
        try {
          const { open } = await import("@tauri-apps/plugin-shell");
          await open(href);
        } catch {
          /* best-effort — pas de note système sur un lien externe qui échoue */
        }
        return;
      }
      showToast(t("common.linkNotFound"));
    },
    [navigate, openNoteByRef, showToast, t]
  );
}
