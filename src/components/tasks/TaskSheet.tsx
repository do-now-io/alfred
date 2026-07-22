import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { MdClose, MdAdd, MdAutoAwesome, MdHub, MdOpenInNew, MdPersonPin } from "react-icons/md";
import { useProfileStore } from "../../store/profileStore";
import { useInternalLink } from "../../utils/useInternalLink";
import { encodeLinkRef } from "../../utils/linkRef";
import { useT } from "../../i18n";
import BriefingContent from "../BriefingContent";
import type { Todo } from "../../bindings/Todo";
import type { TaskFieldsInput } from "../../bindings/TaskFieldsInput";
import type { ChatResponse } from "../../bindings/ChatResponse";

// Fiche tâche (spec/06 2e passe) — ouvrable depuis le Kanban ET la vue Markdown
// (même Todo.md). Édite tous les champs de ligne (titre/@responsable/📅/+projet/
// !priorité/⏱estimation), le bloc (sous-puces libres + description longue),
// affiche la provenance (compte-rendu source, posée par l'ingestion — jamais
// éditable ici) et propose « Rassembler le contexte » (action IA à la demande).

const label: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", color: "var(--text-muted)",
  textTransform: "uppercase", marginBottom: 4, display: "block",
};
const fieldInput: React.CSSProperties = {
  width: "100%", border: "1px solid var(--border)", borderRadius: 8,
  padding: "7px 10px", fontSize: 13.5, background: "var(--bg)", color: "var(--text-primary)",
  outline: "none", boxSizing: "border-box",
};

function Field({ children }: { children: React.ReactNode }) {
  return <div style={{ flex: 1, minWidth: 140 }}>{children}</div>;
}

export default function TaskSheet({
  todo,
  owners,
  projects,
  onClose,
  onSaved,
}: {
  todo: Todo;
  /** Responsables connus, pour la datalist d'autocomplétion. */
  owners: string[];
  /** Projets connus (spec/07 `list_projects`), pour la datalist. */
  projects: string[];
  onClose: () => void;
  onSaved: (updated: Todo) => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const handleLink = useInternalLink();
  const profileName = useProfileStore((s) => s.name);
  const loadProfile = useProfileStore((s) => s.load);
  useEffect(() => { loadProfile(); }, [loadProfile]);

  const [title, setTitle] = useState(todo.title);
  const [responsable, setResponsable] = useState(todo.responsable ?? "");
  const [echeance, setEcheance] = useState(todo.echeance ?? "");
  const [project, setProject] = useState(todo.project ?? "");
  const [priority, setPriority] = useState(todo.priority ?? "");
  const [estimate, setEstimate] = useState(todo.estimate ?? "");
  const [description, setDescription] = useState(todo.description.join("\n"));
  const [notes, setNotes] = useState<string[]>(todo.notes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [context, setContext] = useState<ChatResponse | null>(null);
  const [gathering, setGathering] = useState(false);
  const [gatherError, setGatherError] = useState<string | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const blockTimer = useRef<ReturnType<typeof setTimeout>>();

  // Sauvegarde debounced des champs de ligne — la fiche reste ouverte, pas de
  // bouton « Enregistrer » distinct (cohérent avec l'édition en place du Kanban).
  const saveFields = (patch: Partial<TaskFieldsInput> = {}) => {
    setSaving(true);
    setError(null);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const input: TaskFieldsInput = {
        title, responsable: responsable || null, echeance: echeance || null,
        project: project || null, priority: priority || null, estimate: estimate || null,
        ...patch,
      };
      try {
        const updated = await invoke<Todo>("update_todo_fields", { id: todo.id, input });
        onSaved(updated);
      } catch (e) {
        setError(String(e));
      } finally {
        setSaving(false);
      }
    }, 500);
  };

  const saveBlock = (nextNotes: string[], nextDescription: string) => {
    clearTimeout(blockTimer.current);
    blockTimer.current = setTimeout(async () => {
      try {
        const updated = await invoke<Todo>("update_todo_block", {
          id: todo.id,
          notes: nextNotes.filter((n) => n.trim()),
          description: nextDescription.split("\n").map((l) => l.trim()).filter(Boolean),
        });
        onSaved(updated);
      } catch (e) {
        setError(String(e));
      }
    }, 600);
  };

  useEffect(() => () => { clearTimeout(saveTimer.current); clearTimeout(blockTimer.current); }, []);

  const openSource = () => {
    if (!todo.source_note) return;
    // Réutilise le handler partagé (spec/23) — la résolution manuelle ici
    // n'avait pas le toast de secours : un clic sans effet, silencieux (bug
    // remonté par l'utilisateur : « le lien vers le graphe marche, pas la note »,
    // le bouton graphe naviguant TOUJOURS sans vérifier, contrairement à celui-ci).
    handleLink(`wikilink:${encodeLinkRef(todo.source_note)}`);
  };

  const gatherContext = async () => {
    setGathering(true);
    setGatherError(null);
    try {
      const res = await invoke<ChatResponse>("gather_task_context", {
        title,
        project: project || null,
        sourceNote: todo.source_note ?? null,
      });
      setContext(res);
    } catch (e) {
      setGatherError(String(e));
    } finally {
      setGathering(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1900,
        background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          width: "100%", maxWidth: 620, maxHeight: "86vh", overflowY: "auto",
          padding: "22px 26px", boxShadow: "0 12px 48px rgba(0,0,0,0.3)",
          display: "flex", flexDirection: "column", gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => saveFields({ title })}
            style={{ ...fieldInput, flex: 1, fontSize: 16, fontWeight: 600, border: "none", padding: "2px 0" }}
          />
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex", padding: 4 }}>
            <MdClose size={18} />
          </button>
        </div>

        {error && (
          <div style={{ fontSize: 12, color: "var(--danger)" }}>⚠ {error}</div>
        )}

        {/* Provenance (spec/05/06) — jamais éditable, posée par l'ingestion. */}
        {todo.source_note && (
          <div style={{
            display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
            background: "var(--active-bg)", borderRadius: 8, padding: "7px 11px", fontSize: 12.5,
          }}>
            <span style={{ color: "var(--text-secondary)" }}>
              {t("tasks.sheet.origin", { name: "" })}<strong style={{ color: "var(--text-primary)" }}>{todo.source_note}</strong>
              {todo.source_date && <> · {todo.source_date}</>}
            </span>
            <button onClick={openSource} style={{ ...linkBtn }}>
              <MdOpenInNew size={13} /> {t("tasks.sheet.openNote")}
            </button>
            <button
              onClick={() => navigate(`/graph?focus=${encodeURIComponent(todo.source_note!)}`)}
              style={{ ...linkBtn }}
            >
              <MdHub size={13} /> {t("tasks.sheet.viewInGraph")}
            </button>
          </div>
        )}

        {/* Champs de ligne */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <Field>
            <label style={label}>{t("tasks.sheet.owner")}</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                list="task-sheet-owners"
                value={responsable}
                onChange={(e) => setResponsable(e.target.value)}
                onBlur={() => saveFields({ responsable: responsable || null })}
                placeholder={t("tasks.sheet.namePlaceholder")}
                style={fieldInput}
              />
              {/* @moi (spec/06/10/11) : assigner en un clic avec le profil local. */}
              {profileName && responsable !== profileName && (
                <button
                  onClick={() => { setResponsable(profileName); saveFields({ responsable: profileName }); }}
                  title={t("tasks.sheet.assignToMe")}
                  style={{
                    background: "none", border: "1px solid var(--border)", borderRadius: 8,
                    padding: "0 9px", cursor: "pointer", color: "var(--accent)", display: "flex", alignItems: "center", flexShrink: 0,
                  }}
                >
                  <MdPersonPin size={16} />
                </button>
              )}
            </div>
            <datalist id="task-sheet-owners">
              {owners.map((o) => <option key={o} value={o} />)}
            </datalist>
          </Field>
          <Field>
            <label style={label}>{t("tasks.sheet.due")}</label>
            <input
              type="date"
              value={echeance}
              onChange={(e) => { setEcheance(e.target.value); saveFields({ echeance: e.target.value || null }); }}
              style={fieldInput}
            />
          </Field>
          <Field>
            <label style={label}>{t("tasks.sheet.project")}</label>
            <input
              list="task-sheet-projects"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              onBlur={() => saveFields({ project: project || null })}
              placeholder={t("tasks.sheet.projectPlaceholder")}
              style={fieldInput}
            />
            <datalist id="task-sheet-projects">
              {projects.map((p) => <option key={p} value={p} />)}
            </datalist>
          </Field>
          <Field>
            <label style={label}>{t("tasks.sheet.priority")}</label>
            <select
              className="alfred-select"
              value={priority}
              onChange={(e) => { setPriority(e.target.value); saveFields({ priority: e.target.value || null }); }}
              style={{ width: "100%" }}
            >
              <option value="">{t("tasks.priority.none")}</option>
              <option value="haute">{t("tasks.priority.high")}</option>
              <option value="moyenne">{t("tasks.priority.medium")}</option>
              <option value="basse">{t("tasks.priority.low")}</option>
            </select>
          </Field>
          <Field>
            <label style={label}>{t("tasks.sheet.estimate")}</label>
            <input
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
              onBlur={() => saveFields({ estimate: estimate || null })}
              placeholder={t("tasks.sheet.estimatePlaceholder")}
              style={fieldInput}
            />
          </Field>
        </div>
        {saving && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("tasks.sheet.saving")}</div>}

        {/* Description longue */}
        <div>
          <label style={label}>{t("tasks.sheet.description")}</label>
          <textarea
            value={description}
            onChange={(e) => { setDescription(e.target.value); saveBlock(notes, e.target.value); }}
            placeholder={t("tasks.sheet.descriptionPlaceholder")}
            rows={3}
            style={{ ...fieldInput, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
          />
        </div>

        {/* Sous-puces libres */}
        <div>
          <label style={label}>{t("tasks.sheet.subtasks")}</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {notes.map((n, i) => (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ color: "var(--accent)", fontSize: 13 }}>•</span>
                <input
                  value={n}
                  onChange={(e) => {
                    const next = notes.map((x, idx) => (idx === i ? e.target.value : x));
                    setNotes(next);
                    saveBlock(next, description);
                  }}
                  style={{ ...fieldInput, flex: 1 }}
                />
                <button
                  onClick={() => {
                    const next = notes.filter((_, idx) => idx !== i);
                    setNotes(next);
                    saveBlock(next, description);
                  }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex" }}
                >
                  <MdClose size={14} />
                </button>
              </div>
            ))}
            <button
              onClick={() => setNotes((n) => [...n, ""])}
              style={{
                alignSelf: "flex-start", background: "none", border: "1px dashed var(--border)",
                borderRadius: 6, padding: "4px 10px", cursor: "pointer", color: "var(--text-secondary)",
                fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6,
              }}
            >
              <MdAdd size={13} /> {t("tasks.sheet.addSubtask")}
            </button>
          </div>
        </div>

        {/* Rassembler le contexte — action IA à la demande (spec/07b RAG) */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            onClick={gatherContext}
            disabled={gathering}
            style={{
              alignSelf: "flex-start", background: "var(--accent)", color: "#fff", border: "none",
              borderRadius: 8, padding: "7px 14px", cursor: gathering ? "wait" : "pointer",
              fontSize: 13, fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 8,
            }}
          >
            <MdAutoAwesome size={15} /> {gathering ? t("tasks.sheet.gathering") : t("tasks.sheet.gatherContext")}
          </button>
          {gatherError && <div style={{ fontSize: 12, color: "var(--danger)" }}>⚠ {gatherError}</div>}
          {context && (
            <div style={{ background: "var(--bg)", borderRadius: 10, padding: "10px 14px", fontSize: 13 }}>
              <BriefingContent markdown={context.answer} onNavigate={handleLink} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  background: "none", border: "none", cursor: "pointer", color: "var(--accent)",
  fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4, padding: 0,
};
