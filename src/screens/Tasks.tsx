import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MdCheckBox, MdFolderOff, MdAdd, MdExpandMore, MdExpandLess } from "react-icons/md";
import ShareButton from "../components/ShareButton";
import { useNotesStore } from "../store/notesStore";
import { renderInlineMd, stripInlineMd } from "../utils/inlineMd";
import type { Todo } from "../bindings/Todo";

// Page Tâches — vue KANBAN sur `Todo.md` (spec/06, feedback tests + demande
// users). Le fichier RESTE la source de vérité (compatible Obsidian) : les
// colonnes sont ses sections `##`, le glisser-déposer réécrit le fichier via
// `move_todo` (responsable / échéance / état coché conservés).

const COLUMNS = ["Prioritaire", "En cours", "À faire", "Archivé"] as const;

/** Comparaison insensible à la casse et aux accents (« reunion » matche « Réunion »). */
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

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

const DUE_STYLE: Record<NonNullable<ReturnType<typeof dueKind>>, { bg: string; text: string; label: string }> = {
  late: { bg: "#FEE2E2", text: "#B91C1C", label: "en retard" },
  today: { bg: "#FEF3C7", text: "#B45309", label: "aujourd'hui" },
  soon: { bg: "#DBEAFE", text: "#1D4ED8", label: "cette semaine" },
  later: { bg: "var(--bg)", text: "var(--text-muted)", label: "" },
};

interface DragInfo {
  id: string;
}

export default function Tasks() {
  const { vaultPath, fetchVaultPath } = useNotesStore();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [todoRel, setTodoRel] = useState<string>("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  // Filtres (spec/06) : recherche texte + responsable + échéance.
  const [textFilter, setTextFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState<string>("");
  const [dueFilter, setDueFilter] = useState<"" | "late" | "week">("");
  // Drag en cours + cible de dépôt (colonne, index d'insertion).
  const [drag, setDrag] = useState<DragInfo | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  // Ajout rapide par colonne.
  const [adding, setAdding] = useState<string | null>(null);
  const [addText, setAddText] = useState("");

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

  const visible = useCallback((t: Todo) => {
    if (textFilter.trim()) {
      const q = norm(textFilter.trim());
      // Titre comparé marqueurs markdown retirés (« rapport mensuel » doit
      // matcher « **Rapport** mensuel »).
      if (!norm(stripInlineMd(t.title)).includes(q) && !(t.responsable && norm(t.responsable).includes(q))) return false;
    }
    if (ownerFilter && t.responsable !== ownerFilter) return false;
    if (dueFilter) {
      const k = dueKind(t.echeance);
      if (dueFilter === "late" && k !== "late") return false;
      if (dueFilter === "week" && k !== "today" && k !== "soon" && k !== "late") return false;
    }
    return true;
  }, [textFilter, ownerFilter, dueFilter]);

  const byColumn = useMemo(() => {
    const map = new Map<string, Todo[]>(COLUMNS.map((c) => [c, []]));
    for (const t of todos) {
      const col = map.has(t.section) ? t.section : "À faire";
      map.get(col)!.push(t);
    }
    return map;
  }, [todos]);

  const moveTo = async (id: string, section: string, position?: number) => {
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

  const quickAdd = async (section: string) => {
    const title = addText.trim();
    setAddText("");
    setAdding(null);
    if (!title) return;
    try {
      await invoke("create_todo", { input: { title, responsable: null, echeance: null, section } });
    } catch (e) {
      console.error("[tasks] create_todo failed:", e);
    }
    load();
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
        <h1 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--text-primary)" }}>Tâches</h1>

        {/* Filtres (spec/06) */}
        {showBoard && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 16 }}>
            <input
              value={textFilter}
              onChange={(e) => setTextFilter(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setTextFilter(""); }}
              placeholder="Rechercher…"
              title="Rechercher dans les tâches (titre, responsable) — Échap pour effacer"
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
              title="Filtrer par responsable"
            >
              <option value="">Tous les responsables</option>
              {owners.map((o) => <option key={o} value={o}>@{o}</option>)}
            </select>
            <select
              className="alfred-select"
              value={dueFilter}
              onChange={(e) => setDueFilter(e.target.value as typeof dueFilter)}
              title="Filtrer par échéance"
            >
              <option value="">Toutes les échéances</option>
              <option value="late">En retard</option>
              <option value="week">Cette semaine</option>
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

      {/* Board */}
      <div style={{ flex: 1, overflow: "auto", padding: "18px 24px" }}>
        {!loaded ? null : !vaultPath || error ? (
          <div style={{
            height: "100%", display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-muted)",
          }}>
            <MdFolderOff size={28} />
            <div style={{ fontSize: 14 }}>
              {!vaultPath ? "Aucun dossier Notes configuré" : `Impossible de lire ${todoRel}`}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start", minHeight: "100%" }}>
            {COLUMNS.map((col) => {
              const tasks = (byColumn.get(col) ?? []).filter(visible);
              const isArchive = col === "Archivé";
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
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)" }}>{col}</span>
                    <span style={{
                      fontSize: 11, fontWeight: 600, color: "var(--text-muted)",
                      background: "var(--bg)", borderRadius: 10, padding: "1px 7px",
                    }}>
                      {tasks.length}
                    </span>
                    <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
                      {isArchive && (
                        <button
                          onClick={() => setArchiveOpen((o) => !o)}
                          title={archiveOpen ? "Replier" : "Déplier"}
                          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex", padding: 2 }}
                        >
                          {archiveOpen ? <MdExpandLess size={16} /> : <MdExpandMore size={16} />}
                        </button>
                      )}
                      {!isArchive && (
                        <button
                          onClick={() => { setAdding(col); setAddText(""); }}
                          title="Ajouter une tâche"
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
                      placeholder="Nouvelle tâche…"
                      style={{
                        border: "1px solid var(--accent)", borderRadius: 8, padding: "7px 10px",
                        fontSize: 13, background: "var(--bg)", color: "var(--text-primary)", outline: "none",
                      }}
                    />
                  )}

                  {/* Cards */}
                  {!collapsed && tasks.map((t, idx) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      onToggle={() => toggleChecked(t)}
                      onDragStart={() => setDrag({ id: t.id })}
                      onDragEnd={() => { setDrag(null); setDropCol(null); }}
                      onDropBefore={() => {
                        if (drag && drag.id !== t.id) moveTo(drag.id, col, idx);
                        setDrag(null);
                        setDropCol(null);
                      }}
                    />
                  ))}
                  {!collapsed && tasks.length === 0 && (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", padding: "10px 0" }}>
                      Aucune tâche
                    </div>
                  )}
                  {collapsed && (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "2px 4px" }}>
                      {tasks.length} tâche{tasks.length > 1 ? "s" : ""} archivée{tasks.length > 1 ? "s" : ""}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function TaskCard({
  task, onToggle, onDragStart, onDragEnd, onDropBefore,
}: {
  task: Todo;
  onToggle: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** Déposer une autre carte SUR celle-ci = insérer avant (réordonnancement). */
  onDropBefore: () => void;
}) {
  const due = dueKind(task.echeance);
  const owner = task.responsable;
  return (
    <div
      draggable
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
      {(owner || due) && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", paddingLeft: 24 }}>
          {owner && (() => {
            const { bg, text } = ownerColor(owner);
            return (
              <span
                title={`Responsable : ${owner}`}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  background: bg, color: text, borderRadius: 20,
                  padding: "1px 8px", fontSize: 11.5, fontWeight: 600,
                }}
              >
                {owner}
              </span>
            );
          })()}
          {due && task.echeance && (
            <span style={{
              background: DUE_STYLE[due].bg, color: DUE_STYLE[due].text,
              borderRadius: 20, padding: "1px 8px", fontSize: 11.5, fontWeight: 500,
            }}>
              📅 {task.echeance}{DUE_STYLE[due].label ? ` · ${DUE_STYLE[due].label}` : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
