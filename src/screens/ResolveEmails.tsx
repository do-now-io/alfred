import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { MdCheck, MdMailOutline, MdLightbulbOutline } from "react-icons/md";
import type { PendingEmailReview } from "../bindings/PendingEmailReview";
import { usePendingEmailReviewStore } from "../store/pendingEmailReviewStore";
import { useT } from "../i18n";

// Écran de validation des mails (spec/24 §5) — remplace l'écriture directe de
// l'ancien §4 : chaque tâche/fait proposé par un batch de mails passe par
// cette validation, granularité item par item (pas batch par batch). Style
// visuel proche de `/resolve` (spec/17 §3) mais composant séparé — les mails
// n'ont pas de `recording_id`.

interface TaskPayload {
  title: string;
  responsable?: string | null;
  echeance?: string | null;
  project?: string | null;
}

interface ContextPayload {
  fact: string;
  scope: string;
  projects: string[];
}

const card: React.CSSProperties = {
  background: "var(--card-bg)", border: "1px solid var(--border)",
  borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 6,
};
const actionBtn = (primary?: boolean): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", gap: 4,
  border: `1px solid ${primary ? "var(--accent)" : "var(--border)"}`,
  background: primary ? "var(--accent)" : "transparent",
  color: primary ? "#fff" : "var(--text-secondary)",
  borderRadius: 8, padding: "5px 10px", fontSize: 12.5, cursor: "pointer",
});

export default function ResolveEmails() {
  const t = useT();
  const navigate = useNavigate();
  const fetchCount = usePendingEmailReviewStore((s) => s.fetch);

  const [items, setItems] = useState<PendingEmailReview[]>([]);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const rows = await invoke<PendingEmailReview[]>("list_pending_email_reviews");
      setItems(rows);
      setChecked(Object.fromEntries(rows.map((r) => [Number(r.id), true]))); // coché par défaut (spec/24 §5)
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const parsed = useMemo(
    () =>
      items.map((item) => ({
        item,
        task: item.kind === "task" ? (JSON.parse(item.payload) as TaskPayload) : null,
        context: item.kind === "context" ? (JSON.parse(item.payload) as ContextPayload) : null,
      })),
    [items]
  );

  const validate = async () => {
    setValidating(true);
    setError(null);
    try {
      const acceptedIds = items.filter((i) => checked[Number(i.id)]).map((i) => Number(i.id));
      const rejectedIds = items.filter((i) => !checked[Number(i.id)]).map((i) => Number(i.id));
      await invoke("resolve_email_reviews", { acceptedIds, rejectedIds });
      fetchCount();
      navigate("/settings");
    } catch (e) {
      setError(String(e));
    } finally {
      setValidating(false);
    }
  };

  if (loading) return null;

  if (items.length === 0) {
    return (
      <div style={{ padding: 48, textAlign: "center", color: "var(--text-secondary)" }}>
        <p style={{ fontSize: 15 }}>{t("resolveEmails.empty.text")}</p>
        <button onClick={() => navigate("/settings")} style={{ ...actionBtn(true), marginTop: 12 }}>
          {t("resolveEmails.empty.back")}
        </button>
      </div>
    );
  }

  const count = items.length;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: "20px 24px", gap: 16, boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 20, color: "var(--text-primary)" }}>{t("resolveEmails.header.title")}</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
            {t(count > 1 ? "resolveEmails.header.subtitlePendingPlural" : "resolveEmails.header.subtitlePending", { count })}
          </p>
        </div>
        <button onClick={validate} disabled={validating} style={{ ...actionBtn(true), padding: "7px 16px", fontSize: 13.5, fontWeight: 600 }}>
          {validating ? t("resolveEmails.actions.validating") : t("resolveEmails.actions.validate")}
        </button>
      </div>

      {error && (
        <div style={{ padding: "8px 12px", borderRadius: 8, background: "var(--tag-red-bg)", color: "var(--tag-red-text)", fontSize: 13 }}>{error}</div>
      )}

      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, maxWidth: 640 }}>
        {parsed.map(({ item, task, context }) => {
          const id = Number(item.id);
          return (
          <div key={id} style={card}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <input
                type="checkbox"
                checked={checked[id] ?? true}
                onChange={(e) => setChecked((s) => ({ ...s, [id]: e.target.checked }))}
                style={{ marginTop: 3, flexShrink: 0, accentColor: "var(--accent)" }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>
                  {item.kind === "task" ? <MdCheck /> : <MdLightbulbOutline />}
                  {item.kind === "task" ? t("resolveEmails.item.task") : t("resolveEmails.item.context")}
                </div>
                {task && (
                  <div style={{ fontSize: 13.5, color: "var(--text-primary)" }}>
                    {task.title}
                    {task.project && <span style={{ marginLeft: 6, fontSize: 11.5, color: "var(--text-muted)" }}>{t("resolveEmails.item.taskProject", { project: task.project })}</span>}
                  </div>
                )}
                {context && (
                  <>
                    <div style={{ fontSize: 13.5, color: "var(--text-primary)" }}>{context.fact}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                      {context.scope === "project" && context.projects.length > 0
                        ? t("resolveEmails.item.contextScopeProject", { projects: context.projects.join(", ") })
                        : t("resolveEmails.item.contextScopeGlobal")}
                    </div>
                  </>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, color: "var(--text-secondary)", marginTop: 6 }}>
                  <MdMailOutline size={13} />
                  {item.subject} ({item.email_date})
                </div>
              </div>
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}
