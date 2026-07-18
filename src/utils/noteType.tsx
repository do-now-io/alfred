// Icônes de type de note (spec/07, maquette « Types de fichiers & icônes ») :
// feuille de document au contour léger + glyphe coloré, pour distinguer d'un
// coup d'œil audio (transcription d'enregistrement) / note brute / synthèse
// Alfred / tâches / contexte / note libre. Le type est dérivé du frontmatter
// `type` ET du dossier (alfred-raw = brut, alfred-intelligence = IA), plus les
// fichiers spéciaux par nom ; dans alfred-raw, un nom daté `YYYY-MM-DD HHhMM`
// (format de `format_note_title`, partagé avec le .wav jumeau) ou un
// `recording_id` signale une transcription d'audio.

export type NoteKind = "audio" | "transcription" | "report" | "task" | "context" | "note";

type IconProps = { size?: number; style?: React.CSSProperties };

// Feuille avec coin plié en haut à droite — base commune des six icônes.
function DocIcon({ size = 14, style, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style} aria-hidden>
      <path
        d="M7 2h7l5 5v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"
        stroke="var(--text-muted)" strokeOpacity={0.55} strokeWidth={1.4} strokeLinejoin="round"
      />
      <path
        d="M14 2v3a2 2 0 0 0 2 2h3"
        stroke="var(--text-muted)" strokeOpacity={0.55} strokeWidth={1.4} strokeLinejoin="round"
      />
      {children}
    </svg>
  );
}

/** Audio — forme d'onde (transcription issue d'un enregistrement). */
const AudioIcon = (p: IconProps) => (
  <DocIcon {...p}>
    <g stroke="var(--accent)" strokeWidth={1.5} strokeLinecap="round">
      <path d="M8.4 12.3v2.4" />
      <path d="M10.2 10.8v5.4" />
      <path d="M12 9.6v7.8" />
      <path d="M13.8 10.8v5.4" />
      <path d="M15.6 12.3v2.4" />
    </g>
  </DocIcon>
);

/** Note brute (RAW) — lignes de texte non traité. */
const RawIcon = (p: IconProps) => (
  <DocIcon {...p}>
    <g stroke="var(--text-secondary)" strokeWidth={1.5} strokeLinecap="round">
      <path d="M8.3 11.2h7.4" />
      <path d="M8.3 13.8h7.4" />
      <path d="M8.3 16.4h4.6" />
    </g>
  </DocIcon>
);

/** Synthèse Alfred — étincelle dorée (fichier généré par Alfred). */
const SparkleIcon = (p: IconProps) => (
  <DocIcon {...p}>
    <path
      d="M12 8.6c.42 2.6 1.08 3.26 3.7 3.7-2.62.44-3.28 1.1-3.7 3.7-.42-2.6-1.08-3.26-3.7-3.7 2.62-.44 3.28-1.1 3.7-3.7Z"
      fill="var(--accent)"
    />
  </DocIcon>
);

/** To-do — liste à puces. */
const TodoIcon = (p: IconProps) => (
  <DocIcon {...p}>
    <circle cx="8.9" cy="11.2" r="0.9" fill="var(--text-secondary)" />
    <circle cx="8.9" cy="14.2" r="0.9" fill="var(--text-secondary)" />
    <circle cx="8.9" cy="17.2" r="0.9" fill="var(--text-secondary)" />
    <g stroke="var(--text-secondary)" strokeWidth={1.5} strokeLinecap="round">
      <path d="M11.4 11.2h4.3" />
      <path d="M11.4 14.2h4.3" />
      <path d="M11.4 17.2h4.3" />
    </g>
  </DocIcon>
);

/** Contexte Alfred — silhouette (qui est l'utilisateur). */
const ContextIcon = (p: IconProps) => (
  <DocIcon {...p}>
    <g stroke="var(--text-secondary)" strokeWidth={1.5} strokeLinecap="round" fill="none">
      <circle cx="12" cy="11.6" r="1.9" />
      <path d="M8.7 17.6a3.6 3.2 0 0 1 6.6 0" />
    </g>
  </DocIcon>
);

/** Texte / doc markdown libre. */
const NoteDocIcon = (p: IconProps) => (
  <DocIcon {...p}>
    <g stroke="#7C8A46" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M9.8 10.9 7.8 13l2 2.1" />
      <path d="M14.2 10.9l2 2.1-2 2.1" />
    </g>
  </DocIcon>
);

const KIND_META: Record<NoteKind, { Icon: React.ComponentType<IconProps>; label: string }> = {
  audio: { Icon: AudioIcon, label: "Transcription d'un enregistrement audio" },
  transcription: { Icon: RawIcon, label: "Note brute" },
  report: { Icon: SparkleIcon, label: "Synthèse Alfred (compte-rendu)" },
  task: { Icon: TodoIcon, label: "Tâches" },
  context: { Icon: ContextIcon, label: "Contexte Alfred" },
  note: { Icon: NoteDocIcon, label: "Note" },
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

  if (/^contexte alfred$/i.test(stem)) return "context";
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
    <span title={label} style={{ display: "inline-flex", flexShrink: 0, ...style }}>
      <Icon size={size} />
    </span>
  );
}
