import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  MdCheckBox, MdFolderOff, MdAdd, MdExpandMore, MdExpandLess,
  MdViewColumn, MdViewList, MdChevronRight,
} from "react-icons/md";
import ShareButton from "../components/ShareButton";
import TaskSheet from "../components/tasks/TaskSheet";
import { useNotesStore } from "../store/notesStore";
import { useProfileStore, isSelf } from "../store/profileStore";
import { renderInlineMd, stripInlineMd } from "../utils/inlineMd";
import type { Todo } from "../bindings/Todo";
import { useT, useI18nStore } from "../i18n";
import { TODO_SECTION_LABELS, TODO_SECTION_KEYS, normalizeSectionHeading, type TodoSectionKey } from "../i18n/todoSections";

// Page Tâches — vue KANBAN et vue MARKDOWN (document) sur `Todo.md` (spec/06,
// feedback tests + demande users, 2e passe). Le fichier RESTE la source de
// vérité (compatible Obsidian) : les colonnes/sections sont ses `##`, le
// glisser-déposer et les cases à cocher réécrivent le fichier via les commandes
// (`move_todo`/`complete_todo`) ; les deux vues affichent le même `Todo.md`.
// Cliquer une carte (Kanban) ou une ligne (Markdown) ouvre la **fiche tâche**
// (sous-puces, description, +Projet/priorité/estimation, provenance).

// Colonnes = les 4 sections stables de Todo.md, désormais identifiées par leur
// clé canonique (spec/21 — `../i18n/todoSections.ts`) et non plus par leur
// libellé littéral, pour rester correctes quel que soit la langue de l'UI ou
// celle dans laquelle le vault a été écrit.
const COLUMNS: TodoSectionKey[] = TODO_SECTION_KEYS;

/** Comparaison insensible à la casse et aux accents (« reunion » matche « Réunion »).
 *  Le range ci-dessous couvre le bloc Unicode "Combining Diacritical Marks"
 *  (U+0300–U+036F) — les marques d'accent isolées par `normalize("NFD")`. */
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const CHIP_COLORS = [
  { bg: "#EDE9FE", text: "#6D28D9" },
  { bg: "#DCFCE7", text: "#15803D" },
  { bg: "#FEF3C7", text: "#B45309" },
  { bg: "#DBEAFE", text: "#1D4ED8" },
  { bg: "#FCE7F3", text: "#9D174D" },
];

function ownerColor(name: string) {
  let hash = 0;
  for (const c of name.toLowerCase()) hash = (hash * 31 + c.charCodeAt(0)) & 0xffff;
  return CHIP_COLORS[hash % CHIP_COLORS.length];
}

/** Échéance → proximité (badge coloré, spec/06). */
function dueKind(echeance: string | null | undefined): "late" | "today" | "soon" | "later" | null {
  if (!echeance) return null;
  const due = new Date(`${echeance}T23:59:59`);
  if (isNaN(due.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const diffDays = Math.round((dueDay.getTime() - today.getTime()) / 86_400_000);
  if (diffDays < 0) return "late";
  if (diffDays === 0) return "today";
  if (diffDays <= 7) return "soon";
  return "later";
}

// Libellés affichés via `t()` dans les composants (voir `DUE_LABEL_KEY` /
// `PRIORITY_LABEL_KEY` ci-dessous) — seuls le style et la clé de donnée
// (`haute`/`moyenne`/`basse`, écrits tels quels dans Todo.md) restent ici.
const DUE_STYLE: Record<NonNullable<ReturnType<typeof dueKind>>, { bg: string; text: string }> = {
  late: { bg: "#FEE2E2", text: "#B91C1C" },
  today: { bg: "#FEF3C7", text: "#B45309" },
  soon: { bg: "#DBEAFE", text: "#1D4ED8" },
  later: { bg: "var(--bg)", text: "var(--text-muted)" },
};

const DUE_LABEL_KEY: Record<NonNullable<ReturnType<typeof dueKind>>, string> = {
  late: "tasks.due.late",
  today: "tasks.due.today",
  soon: "tasks.due.soon",
  later: "",
};

const PRIORITY_STYLE: Record<string, { bg: string; text: string }> = {
  haute: { bg: "#FEE2E2", text: "#B91C1C" },
  moyenne: { bg: "#FEF3C7", text: "#B45309" },
  basse: { bg: "var(--bg)", text: "var(--text-muted)" },
};

const PRIORITY_LABEL_KEY: Record<string, string> = {
  haute: "tasks.priority.high",
  moyenne: "tasks.priority.medium",
  basse: "tasks.priority.low",
};

interface DragInfo {
  id: string;
}

export default function Tasks() {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const { vaultPath, fetchVaultPath } = useNotesStore();
  const profileName = useProfileStore((s) => s.name);
  const loadProfile = useProfileStore((s) => s.load);
  useEffect(() => { loadProfile(); }, [loadProfile]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [todoRel, setTodoRel] = useState<string>("");
  const [view, setView] = useState<"kanban" | "markdown">("kanban");
  const [archiveOpen, setArchiveOpen] = useState(false);
  // Filtres (spec/06) : recherche texte + responsable + échéance + projet.
  const [textFilter, setTextFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState<string>("");
  const [dueFilter, setDueFilter] = useState<"" | "late" | "week">("");
  const [projectFilter, setProjectFilter] = useState<string>("");
  // Drag en cours + cible de dépôt (colonne, index d'insertion).
  const [drag, setDrag] = useState<DragInfo | null>(null);
  const [dropCol, setDropCol] = useState<TodoSectionKey | null>(null);
  // Ajout rapide par colonne.
  const [adding, setAdding] = useState<TodoSectionKey | null>(null);
  const [addText, setAddText] = useState("");
  // Sections repliées en vue Markdown (Archivé replié par défaut).
  const [collapsedSections, setCollapsedSections] = useState<Set<TodoSectionKey>>(() => new Set(["archived"]));
  // Fiche tâche ouverte (Kanban ET Markdown, spec/06 2e passe).
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const all = await invoke<Todo[]>("get_all_todos");
      setTodos(all);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { fetchVaultPath(); }, [fetchVaultPath]);
  useEffect(() => {
    invoke<string>("get_todo_file").then(setTodoRel).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const unsubs: Array<() => void> = [];
    listen("todos-updated", () => load()).then((fn) => unsubs.push(fn));
    listen("notes-updated", () => load()).then((fn) => unsubs.push(fn));
    return () => unsubs.forEach((fn) => fn());
  }, [load]);

  const owners = useMemo(() => {
    const set = new Set<string>();
    for (const t of todos) if (t.responsable) set.add(t.responsable);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [todos]);

  const projects = useMemo(() => {
    const set = new Set<string>();
    for (const t of todos) if (t.project) set.add(t.project);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [todos]);

  const openTask = useMemo(() => todos.find((t) => t.id === openTaskId) ?? null, [todos, openTaskId]);

  const visible = useCallback((t: Todo) => {
    if (textFilter.trim()) {
      const q = norm(textFilter.trim());
      // Titre comparé marqueurs markdown retirés (« rapport mensuel » doit
      // matcher « **Rapport** mensuel »).
      if (!norm(stripInlineMd(t.title)).includes(q) && !(t.responsable && norm(t.responsable).includes(q))) return false;
    }
    if (ownerFilter && t.responsable !== ownerFilter) return false;
    if (projectFilter && t.project !== projectFilter) return false;
    if (dueFilter) {
      const k = dueKind(t.echeance);
      if (dueFilter === "late" && k !== "late") return false;
      if (dueFilter === "week" && k !== "today" && k !== "soon" && k !== "late") return false;
    }
    return true;
  }, [textFilter, ownerFilter, dueFilter, projectFilter]);

  const byColumn = useMemo(() => {
    const map = new Map<TodoSectionKey, Todo[]>(COLUMNS.map((c) => [c, []]));
    for (const todo of todos) {
      const key = normalizeSectionHeading(todo.section) ?? "todo";
      map.get(key)!.push(todo);
    }
    return map;
  }, [todos]);

  const moveTo = async (id: string, sectionKey: TodoSectionKey, position?: number) => {
    // Le fichier n'a aucune notion de clé canonique (spec/21) : on y écrit
    // toujours le libellé littéral de la langue courante.
    const section = TODO_SECTION_LABELS[lang][sectionKey];
    // Optimiste : re-sectionne localement, le fichier suit (puis re-lecture).
    setTodos((prev) => {
      const t = prev.find((x) => x.id === id);
      if (!t) return prev;
      const rest = prev.filter((x) => x.id !== id);
      return [...rest, { ...t, section }];
    });
    try {
      await invoke("move_todo", { id, section, position });
    } catch (e) {
      console.error("[tasks] move_todo failed:", e);
    }
    load();
  };

  const toggleChecked = async (t: Todo) => {
    setTodos((prev) => prev.map((x) => (x.id === t.id ? { ...x, checked: !t.checked } : x)));
    try {
      await invoke("complete_todo", { id: t.id, checked: !t.checked });
    } catch (e) {
      console.error("[tasks] complete_todo failed:", e);
    }
    load();
  };

  const quickAdd = async (sectionKey: TodoSectionKey) => {
    const title = addText.trim();
    setAddText("");
    setAdding(null);
    if (!title) return;
    const section = TODO_SECTION_LABELS[lang][sectionKey];
    try {
      await invoke("create_todo", { input: { title, responsable: null, echeance: null, section } });
    } catch (e) {
      console.error("[tasks] create_todo failed:", e);
    }
    load();
  };

  const toggleSection = (section: TodoSectionKey) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section); else next.add(section);
      return next;
    });
  };

  const showBoard = loaded && vaultPath && !error;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        padding: "14px 24px", borderBottom: "1px solid var(--border)", flexShrink: 0,
        background: "var(--card-bg)",
      }}>
        <MdCheckBox style={{ color: "var(--accent)", fontSize: 18 }} />
        <h1 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--text-primary)" }}>{t("tasks.title")}</h1>

        {/* Bascule Kanban / Markdown (spec/06 2e passe) — même Todo.md. */}
        {showBoard && (
          <div style={{ display: "flex", gap: 4, marginLeft: 12 }}>
            <button
              onClick={() => setView("kanban")}
              title={t("tasks.view.kanbanTitle")}
              style={viewToggleBtn(view === "kanban")}
            >
              <MdViewColumn size={15} /> {t("tasks.view.kanban")}
            </button>
            <button
              onClick={() => setView("markdown")}
              title={t("tasks.view.markdownTitle")}
              style={viewToggleBtn(view === "markdown")}
            >
              <MdViewList size={15} /> {t("tasks.view.markdown")}
            </button>
          </div>
        )}

        {/* Filtres (spec/06) */}
        {showBoard && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 16, flexWrap: "wrap" }}>
            <input
              value={textFilter}
              onChange={(e) => setTextFilter(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setTextFilter(""); }}
              placeholder={t("tasks.filters.searchPlaceholder")}
              title={t("tasks.filters.searchTitle")}
              style={{
                border: "1px solid var(--border)", borderRadius: 6,
                padding: "5px 8px", fontSize: 13, width: 160, outline: "none",
                background: "var(--bg)", color: "var(--text-primary)",
              }}
            />
            <select
              className="alfred-select"
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value)}
              title={t("tasks.filters.ownerTitle")}
            >
              <option value="">{t("tasks.filters.allOwners")}</option>
              {owners.map((o) => <option key={o} value={o}>@{o}</option>)}
            </select>
            {projects.length > 0 && (
              <select
                className="alfred-select"
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                title={t("tasks.filters.projectTitle")}
              >
                <option value="">{t("tasks.filters.allProjects")}</option>
                {projects.map((p) => <option key={p} value={p}>+{p}</option>)}
              </select>
            )}
            <select
              className="alfred-select"
              value={dueFilter}
              onChange={(e) => setDueFilter(e.target.value as typeof dueFilter)}
              title={t("tasks.filters.dueTitle")}
            >
              <option value="">{t("tasks.filters.allDue")}</option>
              <option value="late">{t("tasks.filters.late")}</option>
              <option value="week">{t("tasks.filters.week")}</option>
            </select>
          </div>
        )}

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {showBoard && (
            <ShareButton
              getLink={() => invoke<string | null>("get_todos_share_link")}
              share={() => invoke<string>("share_todos")}
              unshare={() => invoke<void>("unshare_todos")}
            />
          )}
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{todoRel}</span>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: view === "kanban" ? "18px 24px" : "18px 24px 40px" }}>
        {!loaded ? null : !vaultPath || error ? (
          <div style={{
            height: "100%", display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-muted)",
          }}>
            <MdFolderOff size={28} />
            <div style={{ fontSize: 14 }}>
              {!vaultPath ? t("tasks.empty.noVault") : t("tasks.empty.readError", { file: todoRel })}
            </div>
          </div>
        ) : view === "kanban" ? (
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start", minHeight: "100%" }}>
            {COLUMNS.map((col) => {
              const colTasks = (byColumn.get(col) ?? []).filter(visible);
              const isArchive = col === "archived";
              const collapsed = isArchive && !archiveOpen;
              return (
                <div
                  key={col}
                  onDragOver={(e) => { if (drag) { e.preventDefault(); setDropCol(col); } }}
                  onDragLeave={() => setDropCol((c) => (c === col ? null : c))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDropCol(null);
                    if (drag) moveTo(drag.id, col);
                    setDrag(null);
                  }}
                  style={{
                    width: collapsed ? 180 : 260, minWidth: collapsed ? 180 : 260,
                    background: "var(--card-bg)", border: "1px solid var(--border)",
                    borderRadius: 12, padding: 10,
                    outline: dropCol === col ? "2px dashed var(--accent)" : "none",
                    display: "flex", flexDirection: "column", gap: 8,
                    transition: "outline 0.1s",
                  }}
                >
                  {/* Column header + compteur + « + » */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px" }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)" }}>{TODO_SECTION_LABELS[lang][col]}</span>
                    <span style={{
                      fontSize: 11, fontWeight: 600, color: "var(--text-muted)",
                      background: "var(--bg)", borderRadius: 10, padding: "1px 7px",
                    }}>
                      {colTasks.length}
                    </span>
                    <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
                      {isArchive && (
                        <button
                          onClick={() => setArchiveOpen((o) => !o)}
                          title={archiveOpen ? t("tasks.column.collapse") : t("tasks.column.expand")}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex", padding: 2 }}
                        >
                          {archiveOpen ? <MdExpandLess size={16} /> : <MdExpandMore size={16} />}
                        </button>
                      )}
                      {!isArchive && (
                        <button
                          onClick={() => { setAdding(col); setAddText(""); }}
                          title={t("tasks.column.addTask")}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", display: "flex", padding: 2 }}
                        >
                          <MdAdd size={16} />
                        </button>
                      )}
                    </span>
                  </div>

                  {/* Quick add */}
                  {adding === col && (
                    <input
                      autoFocus
                      value={addText}
                      onChange={(e) => setAddText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") quickAdd(col);
                        if (e.key === "Escape") { setAdding(null); setAddText(""); }
                      }}
                      onBlur={() => quickAdd(col)}
                      placeholder={t("tasks.column.newTaskPlaceholder")}
                      style={{
                        border: "1px solid var(--accent)", borderRadius: 8, padding: "7px 10px",
                        fontSize: 13, background: "var(--bg)", color: "var(--text-primary)", outline: "none",
                      }}
                    />
                  )}

                  {/* Cards */}
                  {!collapsed && colTasks.map((task, idx) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      profileName={profileName}
                      onToggle={() => toggleChecked(task)}
                      onOpen={() => setOpenTaskId(task.id)}
                      onDragStart={() => setDrag({ id: task.id })}
                      onDragEnd={() => { setDrag(null); setDropCol(null); }}
                      onDropBefore={() => {
                        if (drag && drag.id !== task.id) moveTo(drag.id, col, idx);
                        setDrag(null);
                        setDropCol(null);
                      }}
                    />
                  ))}
                  {!collapsed && colTasks.length === 0 && (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", padding: "10px 0" }}>
                      {t("tasks.empty.noTasks")}
                    </div>
                  )}
                  {collapsed && (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "2px 4px" }}>
                      {t(colTasks.length > 1 ? "tasks.column.archivedCountPlural" : "tasks.column.archivedCount", { count: colTasks.length })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          // Vue Markdown (document) — sections repliables, même Todo.md (spec/06 2e passe).
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 720, margin: "0 auto" }}>
            {COLUMNS.map((col) => {
              const colTasks = (byColumn.get(col) ?? []).filter(visible);
              const isCollapsed = collapsedSections.has(col);
              return (
                <div key={col} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
                  <button
                    onClick={() => toggleSection(col)}
                    style={{
                      display: "flex", alignItems: "center", gap: 6, width: "100%",
                      background: "none", border: "none", cursor: "pointer",
                      padding: "8px 4px", fontSize: 13.5, fontWeight: 700, color: "var(--text-primary)",
                    }}
                  >
                    <MdChevronRight size={16} style={{ transform: isCollapsed ? "none" : "rotate(90deg)", transition: "transform 0.12s", color: "var(--text-muted)" }} />
                    {TODO_SECTION_LABELS[lang][col]}
                    <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>({colTasks.length})</span>
                  </button>
                  {!isCollapsed && (
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      {colTasks.map((task) => (
                        <div
                          key={task.id}
                          onClick={() => setOpenTaskId(task.id)}
                          style={{
                            display: "flex", alignItems: "flex-start", gap: 8,
                            padding: "6px 8px 6px 26px", cursor: "pointer", borderRadius: 6,
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--active-bg)")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                          <input
                            type="checkbox"
                            checked={task.checked}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleChecked(task)}
                            style={{ accentColor: "var(--accent)", marginTop: 3, cursor: "pointer" }}
                          />
                          <span style={{ fontSize: 13.5, lineHeight: 1.5, color: "var(--text-primary)", textDecoration: task.checked ? "line-through" : "none" }}>
                            {renderInlineMd(task.title)}
                            {task.responsable && (
                              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                                {" — @"}{isSelf(task.responsable, profileName) ? t("tasks.owner.me") : task.responsable}
                              </span>
                            )}
                            {task.echeance && <span style={{ color: "var(--text-muted)", fontSize: 12 }}> — 📅 {task.echeance}</span>}
                            {task.project && <span style={{ color: "var(--accent)", fontSize: 12 }}> — +{task.project}</span>}
                          </span>
                        </div>
                      ))}
                      {colTasks.length === 0 && (
                        <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "4px 26px" }}>{t("tasks.empty.noTasks")}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {openTask && (
        <TaskSheet
          todo={openTask}
          owners={owners}
          projects={projects}
          onClose={() => setOpenTaskId(null)}
          onSaved={(updated) => setTodos((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))}
        />
      )}
    </div>
  );
}

function viewToggleBtn(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", gap: 5,
    background: active ? "var(--active-bg)" : "transparent",
    color: active ? "var(--accent)" : "var(--text-secondary)",
    border: "1px solid var(--border)", borderRadius: 6,
    padding: "5px 10px", cursor: "pointer", fontSize: 12.5, fontWeight: active ? 600 : 400,
  };
}

function TaskCard({
  task, profileName, onToggle, onOpen, onDragStart, onDragEnd, onDropBefore,
}: {
  task: Todo;
  /** Profil local (spec/10/11) — pour afficher « moi » sur ses propres tâches. */
  profileName: string;
  onToggle: () => void;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** Déposer une autre carte SUR celle-ci = insérer avant (réordonnancement). */
  onDropBefore: () => void;
}) {
  const t = useT();
  const due = dueKind(task.echeance);
  const dueLabelKey = due ? DUE_LABEL_KEY[due] : "";
  const owner = task.responsable;
  const hasBlock = task.notes.length > 0 || task.description.length > 0;
  return (
    <div
      draggable
      onClick={onOpen}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDropBefore(); }}
      style={{
        background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10,
        padding: "9px 11px", cursor: "grab",
        opacity: task.checked ? 0.55 : 1,
        display: "flex", flexDirection: "column", gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <input
          type="checkbox"
          checked={task.checked}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          style={{ accentColor: "var(--accent)", marginTop: 2, flexShrink: 0, cursor: "pointer" }}
        />
        <span style={{
          fontSize: 13, lineHeight: 1.45, color: "var(--text-primary)",
          textDecoration: task.checked ? "line-through" : "none",
        }}>
          {renderInlineMd(task.title)}
        </span>
      </div>
      {(owner || due || task.project || task.priority || hasBlock) && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", paddingLeft: 24 }}>
          {task.priority && PRIORITY_STYLE[task.priority] && (
            <span style={{
              background: PRIORITY_STYLE[task.priority].bg, color: PRIORITY_STYLE[task.priority].text,
              borderRadius: 20, padding: "1px 8px", fontSize: 11.5, fontWeight: 600,
            }}>
              {t(PRIORITY_LABEL_KEY[task.priority])}
            </span>
          )}
          {task.project && (
            <span style={{
              background: "var(--active-bg)", color: "var(--accent)",
              borderRadius: 20, padding: "1px 8px", fontSize: 11.5, fontWeight: 500,
            }}>
              +{task.project}
            </span>
          )}
          {owner && (() => {
            const { bg, text } = ownerColor(owner);
            const mine = isSelf(owner, profileName);
            return (
              <span
                title={t("tasks.owner.responsibleTitle", { owner })}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  background: bg, color: text, borderRadius: 20,
                  padding: "1px 8px", fontSize: 11.5, fontWeight: 600,
                }}
              >
                {mine ? t("tasks.owner.me") : owner}
              </span>
            );
          })()}
          {due && task.echeance && (
            <span style={{
              background: DUE_STYLE[due].bg, color: DUE_STYLE[due].text,
              borderRadius: 20, padding: "1px 8px", fontSize: 11.5, fontWeight: 500,
            }}>
              📅 {task.echeance}{dueLabelKey ? ` · ${t(dueLabelKey)}` : ""}
            </span>
          )}
          {hasBlock && (
            <span title={t("tasks.card.detailsTitle")} style={{ color: "var(--text-muted)", fontSize: 12 }}>
              ≡
            </span>
          )}
        </div>
      )}
    </div>
  );
}
