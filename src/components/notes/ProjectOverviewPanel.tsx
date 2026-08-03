import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MdClose, MdEvent, MdDescription, MdChecklist } from "react-icons/md";
import { useInternalLink } from "../../utils/useInternalLink";
import { encodeLinkRef } from "../../utils/linkRef";
import { useI18nStore, useT } from "../../i18n";
import { TODO_SECTION_LABELS, normalizeSectionHeading } from "../../i18n/todoSections";
import type { ProjectOverview } from "../../bindings/ProjectOverview";

/** Panneau dédié « Voir l'état du projet » (spec/28, entrée #2) — appelle
 *  directement `get_project_overview` (commande Tauri, agrégation Rust pure),
 *  **zéro appel Claude** sur ce chemin. Rendu entièrement côté frontend à
 *  partir de la structure typée, pas de texte généré (liste organisée). */
export default function ProjectOverviewPanel({ project, onClose }: { project: string; onClose: () => void }) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const handleLink = useInternalLink();
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOverview(null);
    setError(null);
    invoke<ProjectOverview>("get_project_overview", { project })
      .then((o) => { if (!cancelled) setOverview(o); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [project]);

  const priorityLabel = (p: string | null) => {
    if (p === "haute") return t("tasks.priority.high");
    if (p === "moyenne") return t("tasks.priority.medium");
    if (p === "basse") return t("tasks.priority.low");
    return null;
  };

  const sectionLabel = (section: string) => {
    const key = normalizeSectionHeading(section);
    return key ? TODO_SECTION_LABELS[lang][key] : section;
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
          width: "100%", maxWidth: 560, maxHeight: "86vh", overflowY: "auto",
          padding: "22px 26px", boxShadow: "0 12px 48px rgba(0,0,0,0.3)",
          display: "flex", flexDirection: "column", gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", color: "var(--text-muted)", textTransform: "uppercase" }}>
              {t("notes.projectOverview.title")}
            </div>
            <div style={{ fontSize: 17, fontWeight: 600, color: "var(--text-primary)" }}>{project}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex", padding: 4 }}>
            <MdClose size={18} />
          </button>
        </div>

        {error && <div style={{ fontSize: 12, color: "var(--danger)" }}>⚠ {t("notes.projectOverview.error", { error })}</div>}
        {!overview && !error && <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{t("notes.projectOverview.loading")}</div>}

        {overview && (
          <>
            {overview.context_note && (
              <div style={{ background: "var(--active-bg)", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
                  {t("notes.projectOverview.context")}
                </div>
                <div
                  onClick={() => handleLink(`wikilink:${encodeLinkRef(overview.context_note!.path)}`)}
                  style={{ fontSize: 13, color: "var(--text-secondary)", whiteSpace: "pre-line", cursor: "pointer" }}
                >
                  {overview.context_note.excerpt}
                </div>
              </div>
            )}

            <Section icon={<MdChecklist size={14} />} title={t("notes.projectOverview.openTasks")}>
              {overview.open_tasks.length === 0 ? (
                <Empty>{t("notes.projectOverview.noOpenTasks")}</Empty>
              ) : (
                overview.open_tasks.map((task) => (
                  <div
                    key={task.id}
                    onClick={() => handleLink(`task:${encodeLinkRef(task.id)}`)}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "6px 0", borderBottom: "1px solid var(--border)",
                      cursor: "pointer", fontSize: 13.5,
                    }}
                  >
                    <span style={{ flex: 1, color: "var(--text-primary)" }}>{task.title}</span>
                    {task.echeance && <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>📅 {task.echeance}</span>}
                    {priorityLabel(task.priority) && (
                      <span style={{ fontSize: 11, color: "var(--accent)" }}>!{priorityLabel(task.priority)}</span>
                    )}
                    <span style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase" }}>{sectionLabel(task.section)}</span>
                  </div>
                ))
              )}
            </Section>

            <Section icon={<MdDescription size={14} />} title={t("notes.projectOverview.notes")}>
              {overview.notes.length === 0 ? (
                <Empty>{t("notes.projectOverview.noNotes")}</Empty>
              ) : (
                overview.notes.map((n) => (
                  <div
                    key={n.path}
                    onClick={() => handleLink(`wikilink:${encodeLinkRef(n.title)}`)}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "6px 0", borderBottom: "1px solid var(--border)",
                      cursor: "pointer", fontSize: 13.5,
                    }}
                  >
                    <span style={{ flex: 1, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {n.title}
                    </span>
                    {n.date && <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{n.date}</span>}
                  </div>
                ))
              )}
            </Section>

            <Section icon={<MdEvent size={14} />} title={t("notes.projectOverview.agenda")}>
              {overview.events.length === 0 ? (
                <Empty>{t("notes.projectOverview.noEvents")}</Empty>
              ) : (
                overview.events.map((e) => (
                  <div key={e.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 13.5 }}>
                    <div style={{ color: "var(--text-primary)" }}>{e.title}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                      {e.all_day ? e.start_at : `${e.start_at} → ${e.end_at}`}
                    </div>
                  </div>
                ))
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <span style={{ color: "var(--accent)", display: "flex" }}>{icon}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12.5, color: "var(--text-muted)", padding: "4px 0" }}>{children}</div>;
}
