import type { Lang } from "./types";

// Sections stables de Todo.md (spec/06/21) — les en-têtes `## ...` sont des
// DONNÉES parsées (colonnes Kanban, tri), pas seulement de l'affichage. Pour
// qu'un vault écrit en français reste lisible après un passage de l'UI en
// anglais (et vice-versa), on découple une clé stable de son libellé affiché
// par langue : la normalisation ci-dessous reconnaît les en-têtes des DEUX
// langues, l'écriture (backend) utilise la langue courante.
export type TodoSectionKey = "priority" | "in_progress" | "todo" | "archived";

export const TODO_SECTION_KEYS: TodoSectionKey[] = ["priority", "in_progress", "todo", "archived"];

export const TODO_SECTION_LABELS: Record<Lang, Record<TodoSectionKey, string>> = {
  fr: {
    priority: "Prioritaire",
    in_progress: "En cours",
    todo: "À faire",
    archived: "Archivé",
  },
  en: {
    priority: "Priority",
    in_progress: "In Progress",
    todo: "To Do",
    archived: "Archived",
  },
};

const REVERSE_LOOKUP = new Map<string, TodoSectionKey>();
for (const lang of Object.keys(TODO_SECTION_LABELS) as Lang[]) {
  for (const key of TODO_SECTION_KEYS) {
    REVERSE_LOOKUP.set(TODO_SECTION_LABELS[lang][key].toLowerCase(), key);
  }
}

/** Reconnaît un en-tête `## ...` existant (FR **ou** EN) et renvoie sa clé
 *  stable ; `null` si ce n'est pas une des 4 sections connues (section perso
 *  de l'utilisateur — reste affichée telle quelle, jamais renommée). */
export function normalizeSectionHeading(heading: string): TodoSectionKey | null {
  return REVERSE_LOOKUP.get(heading.trim().toLowerCase()) ?? null;
}
