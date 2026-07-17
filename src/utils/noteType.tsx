import { MdGraphicEq, MdDescription, MdCheckBox, MdContactPage, MdStickyNote2 } from "react-icons/md";

// Icône de type de note (spec/07, feedback tests) : distinguer transcription /
// compte-rendu / tâche / contexte / note libre SANS ouvrir la note. Le type est
// dérivé du frontmatter `type` ET du dossier (alfred-raw = brut,
// alfred-intelligence = IA), plus les fichiers spéciaux par nom.

export type NoteKind = "transcription" | "report" | "task" | "context" | "note";

const KIND_META: Record<NoteKind, { Icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>; label: string }> = {
  transcription: { Icon: MdGraphicEq, label: "Transcription brute" },
  report: { Icon: MdDescription, label: "Compte-rendu" },
  task: { Icon: MdCheckBox, label: "Tâches" },
  context: { Icon: MdContactPage, label: "Contexte Alfred" },
  note: { Icon: MdStickyNote2, label: "Note" },
};

/** Dérive le type d'une note de son chemin (+ frontmatter quand connu). */
export function noteKind({
  path,
  noteType,
  recordingId,
}: {
  path: string;
  noteType?: string | null;
  recordingId?: string | null;
}): NoteKind {
  const p = path.replace(/\\/g, "/");
  const file = p.split("/").pop() ?? "";
  const stem = file.replace(/\.md$/i, "");

  if (/^contexte alfred$/i.test(stem)) return "context";
  if (/^todo$/i.test(stem) || noteType === "task") return "task";
  // Dossier brut → transcription (le frontmatter `for_recording`/`recording_id`
  // vit sur ces notes, mais le dossier suffit et couvre les notes sans frontmatter).
  if (p.includes("/alfred-raw/")) return "transcription";
  if (p.includes("/alfred-intelligence/") || noteType === "meeting") {
    // Un compte-rendu porte type meeting ; une transcription déplacée aussi —
    // le recording_id seul ne discrimine pas, le dossier a déjà tranché ci-dessus.
    void recordingId;
    return "report";
  }
  return "note";
}

export function noteKindMeta(kind: NoteKind) {
  return KIND_META[kind];
}

/** Icône prête à poser (arbre, Récents, vue Projets). */
export function NoteTypeIcon({
  path,
  noteType,
  recordingId,
  size = 14,
  style,
}: {
  path: string;
  noteType?: string | null;
  recordingId?: string | null;
  size?: number;
  style?: React.CSSProperties;
}) {
  const kind = noteKind({ path, noteType, recordingId });
  const { Icon, label } = KIND_META[kind];
  return (
    <span title={label} style={{ display: "inline-flex", flexShrink: 0, color: "var(--text-muted)", ...style }}>
      <Icon size={size} />
    </span>
  );
}
