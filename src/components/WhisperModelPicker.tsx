import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MdCheckCircle, MdDeleteOutline, MdDownload } from "react-icons/md";
import type { WhisperModelInfo } from "../bindings/WhisperModelInfo";
import { t as translate, useT } from "../i18n";

// Gestionnaire de modèles Whisper (spec/04) — partagé entre l'étape
// d'onboarding (spec/13) et Réglages → Transcription (spec/11). Autonome :
// charge sa liste via `list_whisper_models` et suit les téléchargements via
// les événements `download-progress` / `download-complete` / `download-error`
// (filtrés par nom de modèle), ce qui lui permet de ré-afficher une
// progression déjà en cours (onboarding passé pendant un téléchargement).

const MODEL_KEYS: Record<string, string> = {
  tiny: "tiny",
  base: "base",
  small: "small",
  medium: "medium",
  "large-v3-turbo": "largeV3Turbo",
};

const smallBtn = (danger = false): React.CSSProperties => ({
  background: "none",
  border: `1px solid ${danger ? "var(--danger)" : "var(--border)"}`,
  borderRadius: 8, padding: "5px 12px", cursor: "pointer",
  color: danger ? "var(--danger)" : "var(--text-primary)", fontSize: 12,
  display: "inline-flex", alignItems: "center", gap: 5,
});

export default function WhisperModelPicker({ onBusyChange }: {
  /** Prévient le parent quand un téléchargement tourne (gating « Suivant » de l'onboarding). */
  onBusyChange?: (busy: boolean) => void;
}) {
  const t = useT();
  const formatSize = useCallback((mb: number): string => {
    return mb >= 1000
      ? `${(mb / 1024).toFixed(1)} ${t("settings.whisperModelPicker.gigabytes")}`
      : `${mb} ${t("settings.whisperModelPicker.megabytes")}`;
  }, [t]);
  const [models, setModels] = useState<WhisperModelInfo[] | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const refresh = useCallback(async (): Promise<WhisperModelInfo[]> => {
    try {
      const list = await invoke<WhisperModelInfo[]>("list_whisper_models");
      setModels(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  // Premier modèle téléchargé → devient actif (cas onboarding : l'actif par
  // défaut `small` n'existe pas encore sur disque ; si l'utilisateur télécharge
  // medium, c'est medium qu'il veut utiliser). Ne touche à rien si le modèle
  // actif est déjà téléchargé (pré-téléchargement depuis les Réglages).
  const handleComplete = useCallback(async (model: string) => {
    const list = await refresh();
    const activeDownloaded = list.some((m) => m.active && m.status === "downloaded");
    if (!activeDownloaded && list.some((m) => m.name === model)) {
      try {
        await invoke("set_config", { key: "whisper_model", value: model });
        await refresh();
      } catch { /* non-fatal : le modèle reste téléchargé, activable à la main */ }
    }
  }, [refresh]);

  useEffect(() => {
    refresh();
    const unsubs: (() => void)[] = [];
    listen<{ model: string; percent: number }>("download-progress", (e) => {
      setProgress((p) => ({ ...p, [e.payload.model]: e.payload.percent }));
    }).then((fn) => unsubs.push(fn));
    listen<{ model: string }>("download-complete", (e) => {
      setProgress((p) => { const n = { ...p }; delete n[e.payload.model]; return n; });
      setErrors((p) => { const n = { ...p }; delete n[e.payload.model]; return n; });
      void handleComplete(e.payload.model);
    }).then((fn) => unsubs.push(fn));
    listen<{ model: string; message: string; cancelled?: boolean }>("download-error", (e) => {
      setProgress((p) => { const n = { ...p }; delete n[e.payload.model]; return n; });
      if (!e.payload.cancelled) {
        setErrors((p) => ({ ...p, [e.payload.model]: translate("settings.whisperModelPicker.downloadFailed") }));
      }
      refresh();
    }).then((fn) => unsubs.push(fn));
    return () => unsubs.forEach((fn) => fn());
  }, [refresh, handleComplete]);

  const busy = (models?.some((m) => m.status === "downloading") ?? false) || Object.keys(progress).length > 0;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const download = (name: string) => {
    setErrors((p) => { const n = { ...p }; delete n[name]; return n; });
    setProgress((p) => ({ ...p, [name]: 0 }));
    // La promesse ne se résout qu'en fin de téléchargement — l'UI est pilotée
    // par les événements ; le catch évite juste un unhandled rejection (l'échec
    // arrive aussi par `download-error`).
    invoke("download_model", { size: name }).catch(() => {});
  };

  const use = async (name: string) => {
    try {
      await invoke("set_config", { key: "whisper_model", value: name });
      await refresh();
    } catch { /* non-fatal */ }
  };

  const cancel = (name: string) => {
    invoke("cancel_model_download", { size: name }).catch(() => {});
  };

  const remove = async (name: string) => {
    try {
      await invoke("delete_whisper_model", { size: name });
    } catch (e) {
      setErrors((p) => ({ ...p, [name]: String(e) }));
    }
    await refresh();
  };

  if (models === null) {
    return <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{t("settings.whisperModelPicker.loading")}</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
      {models.map((m) => {
        const modelKey = MODEL_KEYS[m.name];
        const copy = modelKey
          ? {
              label: t(`settings.whisperModelPicker.models.${modelKey}.label`),
              desc: t(`settings.whisperModelPicker.models.${modelKey}.desc`),
            }
          : { label: m.name, desc: "" };
        const percent = progress[m.name];
        const downloading = m.status === "downloading" || percent !== undefined;
        const downloaded = m.status === "downloaded";
        return (
          <div
            key={m.name}
            style={{
              border: `1px solid ${m.active && downloaded ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 10, padding: "10px 14px",
              display: "flex", alignItems: "center", gap: 12, textAlign: "left",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{copy.label}</span>
                {m.recommended && (
                  <span style={{
                    fontSize: 11, fontWeight: 600, color: "var(--accent)",
                    border: "1px solid var(--accent)", borderRadius: 20, padding: "1px 8px",
                  }}>
                    {t("settings.whisperModelPicker.recommended")}
                  </span>
                )}
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{formatSize(m.size_mb)}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{copy.desc}</div>
              {downloading && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                  <div style={{ flex: 1, height: 6, borderRadius: 4, background: "var(--border)", overflow: "hidden" }}>
                    <div style={{
                      width: `${percent ?? 0}%`, height: "100%", background: "var(--accent)",
                      borderRadius: 4, transition: "width 0.3s ease",
                    }} />
                  </div>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)", flexShrink: 0 }}>
                    {Math.round(percent ?? 0)} %
                  </span>
                </div>
              )}
              {errors[m.name] && !downloading && (
                <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>{errors[m.name]}</div>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              {downloading ? (
                <button onClick={() => cancel(m.name)} style={smallBtn(true)}>{t("settings.whisperModelPicker.cancel")}</button>
              ) : downloaded && m.active ? (
                <span style={{
                  fontSize: 12, fontWeight: 600, color: "#34C759",
                  display: "inline-flex", alignItems: "center", gap: 5,
                }}>
                  <MdCheckCircle size={15} /> {t("settings.whisperModelPicker.active")}
                </span>
              ) : downloaded ? (
                <>
                  <button onClick={() => use(m.name)} style={smallBtn()}>{t("settings.whisperModelPicker.use")}</button>
                  <button
                    onClick={() => remove(m.name)}
                    title={t("settings.whisperModelPicker.removeTitle")}
                    style={{ ...smallBtn(), padding: "5px 7px", color: "var(--text-muted)" }}
                  >
                    <MdDeleteOutline size={15} />
                  </button>
                </>
              ) : (
                <button onClick={() => download(m.name)} style={smallBtn()}>
                  <MdDownload size={14} /> {errors[m.name] ? t("settings.whisperModelPicker.retry") : t("settings.whisperModelPicker.download")}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
