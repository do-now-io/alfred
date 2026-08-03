import { MdGraphicEq, MdSubject, MdDescription, MdCheckBox, MdContactPage, MdStickyNote2 } from "react-icons/md";
import { useT, t as translate } from "../i18n";

// Icônes de type de note (spec/07) : glyphes Material Design (react-icons/md) —
// du SVG inline embarqué au build, donc identique sur Windows/macOS/Linux (pas
// de police d'icônes système, pas de dépendance à la plateforme). Choisis pour
// être reconnaissables et lisibles même en petit (arbre, Récents), contrairement
// aux icônes « page + glyphe interne » (maquette précédente) jugées trop
// discrètes et trop semblables entre elles au retour des tests.
//
// Le type est dérivé du frontmatter `type` ET du dossier (alfred-raw = brut,
// alfred-intelligence = IA), plus les fichiers spéciaux par nom ; dans
// alfred-raw, un nom daté `YYYY-MM-DD HHhMM` (format de `format_note_title`,
// partagé avec le .wav jumeau) ou un `recording_id` signale une transcription
// d'audio (distincte d'une note brute quelconque).

export type NoteKind = "audio" | "transcription" | "report" | "task" | "context" | "note";

type IconProps = { size?: number; style?: React.CSSProperties };

const KIND_META: Record<NoteKind, { Icon: React.ComponentType<IconProps>; labelKey: string }> = {
  audio: { Icon: MdGraphicEq, labelKey: "notes.noteType.audio" },
  transcription: { Icon: MdSubject, labelKey: "notes.noteType.transcription" },
  report: { Icon: MdDescription, labelKey: "notes.noteType.report" },
  task: { Icon: MdCheckBox, labelKey: "notes.noteType.task" },
  context: { Icon: MdContactPage, labelKey: "notes.noteType.context" },
  note: { Icon: MdStickyNote2, labelKey: "notes.noteType.note" },
};

// Nom daté produit par `format_note_title` (transcriptions ET .wav jumeau).
const DATED_STEM = /^\d{4}-\d{2}-\d{2} \d{2}h\d{2}/;

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

  // spec/16b : reconnue par le frontmatter `type: context` — couvre à la fois
  // le contexte global et chaque note de contexte de projet, sans énumérer de
  // chemins. Le nom de fichier reste un repli pour les vaults pas encore
  // migrés (note de contexte globale écrite avant l'introduction de ce champ,
  // encore `type: note` tant qu'elle n'a pas été réécrite).
  if (noteType === "context" || /^contexte alfred$/i.test(stem)) return "context";
  if (/^todo$/i.test(stem) || noteType === "task") return "task";
  // Dossier brut → audio si la note vient d'un enregistrement (nom daté — seule
  // info dispo dans l'arbre — ou recording_id), sinon note brute.
  if (p.includes("/alfred-raw/")) {
    return DATED_STEM.test(stem) || recordingId ? "audio" : "transcription";
  }
  if (p.includes("/alfred-intelligence/") || noteType === "meeting") {
    return "report";
  }
  return "note";
}

/** Hors composant React (pas de hook disponible ici) — lit la langue courante
 *  via l'export non-hook de i18n. */
export function noteKindMeta(kind: NoteKind) {
  const { Icon, labelKey } = KIND_META[kind];
  return { Icon, label: translate(labelKey) };
}

/** Icône prête à poser (arbre, Récents, vue Projets). */
export function NoteTypeIcon({
  path,
  noteType,
  recordingId,
  size = 15,
  style,
}: {
  path: string;
  noteType?: string | null;
  recordingId?: string | null;
  size?: number;
  style?: React.CSSProperties;
}) {
  const t = useT();
  const kind = noteKind({ path, noteType, recordingId });
  const { Icon, labelKey } = KIND_META[kind];
  return (
    <span title={t(labelKey)} style={{ display: "inline-flex", flexShrink: 0, color: "var(--text-muted)", ...style }}>
      <Icon size={size} />
    </span>
  );
}
