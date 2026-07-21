import type { Lang } from "./types";

// Sections stables de Todo.md (spec/06 v2/21) — les en-têtes `## ...` sont des
// DONNÉES parsées (colonnes Kanban, tri), pas seulement de l'affichage. Pour
// qu'un vault écrit en français reste lisible après un passage de l'UI en
// anglais (et vice-versa), on découple une clé stable de son libellé affiché
// par langue : la normalisation ci-dessous reconnaît les en-têtes des DEUX
// langues, l'écriture (backend) utilise la langue courante.
//
// `priority` (Prioritaire) a été RETIRÉE (spec/06 v2, feedback tests) : la
// priorité vit désormais uniquement en marqueur inline `!haute`/etc. `done`
// (Fait) est nouvelle — cocher une tâche la déplace dans cette section.
export type TodoSectionKey = "todo" | "in_progress" | "done" | "archived";

export const TODO_SECTION_KEYS: TodoSectionKey[] = ["todo", "in_progress", "done", "archived"];

export const TODO_SECTION_LABELS: Record<Lang, Record<TodoSectionKey, string>> = {
  fr: {
    todo: "À faire",
    in_progress: "En cours",
    done: "Fait",
    archived: "Archivé",
  },
  en: {
    todo: "To Do",
    in_progress: "In Progress",
    done: "Done",
    archived: "Archived",
  },
};

const REVERSE_LOOKUP = new Map<string, TodoSectionKey>();
for (const lang of Object.keys(TODO_SECTION_LABELS) as Lang[]) {
  for (const key of TODO_SECTION_KEYS) {
    REVERSE_LOOKUP.set(TODO_SECTION_LABELS[lang][key].toLowerCase(), key);
  }
}
// Alias de migration (spec/06 v2) : anciens en-têtes retirés, reconnus dans
// les fichiers écrits avant le retrait de "Prioritaire" — replie sur "todo"
// (même section d'accueil que côté backend, voir todo_md.rs::migration_alias),
// sans attendre la réécriture physique du fichier.
REVERSE_LOOKUP.set("prioritaire", "todo");
REVERSE_LOOKUP.set("priority", "todo");

/** Reconnaît un en-tête `## ...` existant (FR **ou** EN, ou un ancien en-tête
 *  retiré) et renvoie sa clé stable ; `null` si ce n'est pas une des sections
 *  connues (section perso de l'utilisateur — reste affichée telle quelle,
 *  jamais renommée). */
export function normalizeSectionHeading(heading: string): TodoSectionKey | null {
  return REVERSE_LOOKUP.get(heading.trim().toLowerCase()) ?? null;
}
