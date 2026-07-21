import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { MdMic, MdStop, MdAdd, MdClose, MdCheckCircle, MdWarning, MdHourglassEmpty, MdPause, MdPlayArrow } from "react-icons/md";
import { useRecordingStore, useRecordingElapsed } from "../store/recordingStore";
import { useAlfredStatusStore } from "../store/alfredStatusStore";
import VolumeMeter from "../components/VolumeMeter";
import AlfredAvatar from "../components/AlfredAvatar";
import { useT } from "../i18n";

// The recording guidance page (spec/03): reached by clicking the sidebar logo
// (or the Dashboard's recording card). Shows live feedback (timer + volume) and
// the capture tips that make a recording actually transcribe/extract well.

// Conseils de captation PAR TYPE (spec/03, feedback tests) : chaque type de
// captation a sa phrase d'ouverture (ce qu'il faut dire en premier) + ses
// conseils ciblés. Config `capture_tips` = dict `{ [type]: { opener, tips[] } }`
// (l'ancienne liste plate est migrée vers le type « libre »).

interface CaptureTypeTips {
  opener: string;
  tips: string[];
}

function getCaptureTypes(t: ReturnType<typeof useT>): Array<{ id: string; label: string }> {
  return [
    { id: "perso", label: t("recording.guide.captureTypes.perso") },
    { id: "client", label: t("recording.guide.captureTypes.client") },
    { id: "one2one", label: t("recording.guide.captureTypes.one2one") },
    { id: "equipe", label: t("recording.guide.captureTypes.equipe") },
    { id: "libre", label: t("recording.guide.captureTypes.libre") },
  ];
}

function getDefaultTipsByType(t: ReturnType<typeof useT>): Record<string, CaptureTypeTips> {
  return {
    perso: {
      opener: t("recording.guide.defaultTips.perso.opener"),
      tips: [
        t("recording.guide.defaultTips.perso.tip1"),
        t("recording.guide.defaultTips.perso.tip2"),
        t("recording.guide.defaultTips.perso.tip3"),
      ],
    },
    client: {
      opener: t("recording.guide.defaultTips.client.opener"),
      tips: [
        t("recording.guide.defaultTips.client.tip1"),
        t("recording.guide.defaultTips.client.tip2"),
        t("recording.guide.defaultTips.client.tip3"),
        t("recording.guide.defaultTips.client.tip4"),
        t("recording.guide.defaultTips.client.tip5"),
      ],
    },
    one2one: {
      opener: t("recording.guide.defaultTips.one2one.opener"),
      tips: [
        t("recording.guide.defaultTips.one2one.tip1"),
        t("recording.guide.defaultTips.one2one.tip2"),
        t("recording.guide.defaultTips.one2one.tip3"),
      ],
    },
    equipe: {
      opener: t("recording.guide.defaultTips.equipe.opener"),
      tips: [
        t("recording.guide.defaultTips.equipe.tip1"),
        t("recording.guide.defaultTips.equipe.tip2"),
        t("recording.guide.defaultTips.equipe.tip3"),
        t("recording.guide.defaultTips.equipe.tip4"),
      ],
    },
    libre: {
      opener: t("recording.guide.defaultTips.libre.opener"),
      tips: [
        t("recording.guide.defaultTips.libre.tip1"),
        t("recording.guide.defaultTips.libre.tip2"),
        t("recording.guide.defaultTips.libre.tip3"),
        t("recording.guide.defaultTips.libre.tip4"),
      ],
    },
  };
}

const CAPTURE_TIPS_KEY = "capture_tips";

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ─── Editable capture tips, per type (spec/03) ─────────────────────────────────

function useCaptureTips() {
  const t = useT();
  // Overrides saved by the user (config JSON) ; les valeurs par défaut restent
  // dérivées de `t` pour rester traduites même après un changement de langue.
  const [customByType, setCustomByType] = useState<Record<string, CaptureTypeTips> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    invoke<string | null>("get_config", { key: CAPTURE_TIPS_KEY }).then((raw) => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          // Ancien format (liste plate) → migré vers le type « libre ».
          if (parsed.length > 0) {
            setCustomByType((prev) => ({ ...(prev ?? {}), libre: { ...(prev?.libre ?? getDefaultTipsByType(t).libre), tips: parsed } }));
          }
        } else if (parsed && typeof parsed === "object") {
          setCustomByType((prev) => {
            const next = { ...(prev ?? {}) };
            for (const [k, v] of Object.entries(parsed as Record<string, CaptureTypeTips>)) {
              if (v && typeof v.opener === "string" && Array.isArray(v.tips)) next[k] = v;
            }
            return next;
          });
        }
      } catch { /* fall back to defaults */ }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    });
  }, []);

  const byType = { ...getDefaultTipsByType(t), ...(customByType ?? {}) };

  const persist = (next: Record<string, CaptureTypeTips>) => {
    setCustomByType(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      invoke("set_config", { key: CAPTURE_TIPS_KEY, value: JSON.stringify(next) }).catch(() => {});
    }, 500);
  };

  return { byType, persist };
}

function TipsEditor() {
  const t = useT();
  const { byType, persist } = useCaptureTips();
  const [editing, setEditing] = useState(false);
  const [type, setType] = useState("libre");
  const captureTypes = getCaptureTypes(t);

  const current = byType[type] ?? getDefaultTipsByType(t).libre;
  const patch = (p: Partial<CaptureTypeTips>) =>
    persist({ ...byType, [type]: { ...current, ...p } });

  const update = (i: number, text: string) => patch({ tips: current.tips.map((tip, idx) => (idx === i ? text : tip)) });
  const remove = (i: number) => patch({ tips: current.tips.filter((_, idx) => idx !== i) });
  const add = () => patch({ tips: [...current.tips, ""] });

  return (
    <div className="card" style={{ padding: "18px 22px" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 14.5, fontWeight: 600, color: "var(--text-primary)" }}>
          {t("recording.guide.captureTipsTitle")}
        </h2>
        <button
          onClick={() => setEditing((e) => !e)}
          style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: 12, fontWeight: 500 }}
        >
          {editing ? t("recording.guide.doneEditingTips") : t("recording.guide.editTips")}
        </button>
      </div>

      {/* Sélecteur de type (spec/03) — le guidage s'adapte au type de captation. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {captureTypes.map((ct) => (
          <button
            key={ct.id}
            onClick={() => setType(ct.id)}
            style={{
              background: type === ct.id ? "var(--active-bg)" : "transparent",
              color: type === ct.id ? "var(--accent)" : "var(--text-secondary)",
              border: "1px solid var(--border)", borderRadius: 16,
              padding: "4px 11px", cursor: "pointer", fontSize: 12, fontWeight: type === ct.id ? 600 : 400,
            }}
          >
            {ct.label}
          </button>
        ))}
      </div>

      {/* Phrase d'ouverture — ce qu'il faut dire en premier. */}
      <div style={{
        display: "flex", gap: 8, alignItems: "center", marginBottom: 10,
        padding: "8px 12px", borderRadius: 8, background: "var(--active-bg)",
      }}>
        <span style={{ fontSize: 15, flexShrink: 0 }}>🗣️</span>
        {editing ? (
          <input
            value={current.opener}
            onChange={(e) => patch({ opener: e.target.value })}
            style={{
              flex: 1, border: "1px solid var(--border)", borderRadius: 6,
              padding: "5px 9px", fontSize: 13, background: "var(--card-bg)", color: "var(--text-primary)",
            }}
          />
        ) : (
          <span style={{ fontSize: 13.5, color: "var(--text-primary)", fontWeight: 500, lineHeight: 1.5 }}>
            {t("recording.guide.openerPrefix")} {current.opener}
          </span>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {current.tips.map((tip, i) =>
          editing ? (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                value={tip}
                onChange={(e) => update(i, e.target.value)}
                style={{
                  flex: 1, border: "1px solid var(--border)", borderRadius: 6,
                  padding: "6px 10px", fontSize: 13, background: "var(--bg)", color: "var(--text-primary)",
                }}
              />
              <button
                onClick={() => remove(i)}
                title={t("recording.guide.removeTip")}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex" }}
              >
                <MdClose size={16} />
              </button>
            </div>
          ) : (
            <div key={i} style={{ display: "flex", gap: 8, fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              <span style={{ color: "var(--accent)" }}>•</span>
              <span>{tip}</span>
            </div>
          )
        )}
      </div>

      {editing && (
        <button
          onClick={add}
          style={{
            marginTop: 10, background: "none", border: "1px dashed var(--border)", borderRadius: 6,
            padding: "6px 10px", cursor: "pointer", color: "var(--text-secondary)", fontSize: 12.5,
            display: "inline-flex", alignItems: "center", gap: 6,
          }}
        >
          <MdAdd size={14} /> {t("recording.guide.addTip")}
        </button>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function RecordingGuide() {
  const t = useT();
  const navigate = useNavigate();
  const { status, volume, errorMessage, startRecording, stopRecording, cancelRecording, pauseRecording, resumeRecording } = useRecordingStore();
  const elapsed = useRecordingElapsed();
  // Progression réelle de la transcription (spec/04, feedback tests).
  const transcriptionPercent = useAlfredStatusStore((s) => (s.state === "transcribing" ? s.progress : null));

  const isIdle = status === "idle";
  const isPaused = status === "paused";
  const isRecording = status === "recording" || isPaused;
  const isProcessing = status === "stopping" || status === "processing";
  const isError = status === "error";

  const cancel = () => {
    if (window.confirm(t("recording.guide.confirmDeleteRecording"))) {
      cancelRecording();
    }
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", display: "flex", justifyContent: "center", padding: "40px 24px" }}>
      <div style={{ width: "100%", maxWidth: 560, display: "flex", flexDirection: "column", gap: 20 }}>
        <div className="card" style={{ padding: "32px 28px", display: "flex", flexDirection: "column", alignItems: "center", gap: 16, textAlign: "center" }}>
          <AlfredAvatar size={56} />

          {isRecording && (
            <>
              <div style={{ fontVariantNumeric: "tabular-nums", fontSize: 34, fontWeight: 700, color: isPaused ? "var(--text-muted)" : "var(--danger)" }}>
                {formatDuration(elapsed)}
              </div>
              <VolumeMeter volume={volume} size="lg" />
              <div style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>
                {isPaused ? t("recording.guide.pausedHint") : t("recording.guide.recordingHint")}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  onClick={cancel}
                  title={t("recording.guide.cancelTitle")}
                  style={{
                    background: "none", color: "var(--text-muted)", border: "1px solid var(--border)",
                    borderRadius: 10, padding: "9px 16px", cursor: "pointer", fontSize: 13.5,
                    display: "inline-flex", alignItems: "center", gap: 6,
                  }}
                >
                  <MdClose size={16} /> {t("recording.guide.cancel")}
                </button>
                <button
                  onClick={isPaused ? resumeRecording : pauseRecording}
                  style={{
                    background: "none", color: "var(--text-secondary)", border: "1px solid var(--border)",
                    borderRadius: 10, padding: "9px 16px", cursor: "pointer", fontSize: 13.5, fontWeight: 500,
                    display: "inline-flex", alignItems: "center", gap: 6,
                  }}
                >
                  {isPaused ? <><MdPlayArrow size={17} /> {t("recording.guide.resume")}</> : <><MdPause size={16} /> {t("recording.guide.pause")}</>}
                </button>
                <button
                  onClick={stopRecording}
                  style={{
                    background: "var(--danger)", color: "#fff", border: "none", borderRadius: 10,
                    padding: "10px 24px", cursor: "pointer", fontSize: 14, fontWeight: 600,
                    display: "inline-flex", alignItems: "center", gap: 8,
                  }}
                >
                  <MdStop size={18} /> {t("recording.guide.finish")}
                </button>
              </div>
            </>
          )}

          {isProcessing && (
            <>
              <MdHourglassEmpty size={32} style={{ color: "var(--text-muted)" }} />
              <div style={{ fontSize: 16, color: "var(--text-secondary)" }}>
                {t("recording.guide.transcribing")}{transcriptionPercent != null ? ` ${transcriptionPercent} %` : ""}
              </div>
              {transcriptionPercent != null && (
                <div style={{ width: "100%", maxWidth: 280, height: 6, borderRadius: 4, background: "var(--border)", overflow: "hidden" }}>
                  <div style={{
                    width: `${transcriptionPercent}%`, height: "100%", background: "var(--accent)",
                    borderRadius: 4, transition: "width 0.3s ease",
                  }} />
                </div>
              )}
              <button
                onClick={() => navigate("/")}
                style={{ background: "none", border: "1px solid var(--border)", borderRadius: 8, padding: "7px 16px", cursor: "pointer", color: "var(--text-secondary)", fontSize: 13 }}
              >
                {t("recording.guide.continueHome")}
              </button>
            </>
          )}

          {isError && (
            <>
              <MdWarning size={28} style={{ color: "var(--danger)" }} />
              <div style={{ fontSize: 14, color: "var(--danger)" }}>{errorMessage ?? t("recording.guide.unknownError")}</div>
              <button
                onClick={() => startRecording()}
                style={{ background: "var(--accent)", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontSize: 13.5, fontWeight: 500 }}
              >
                {t("recording.guide.retry")}
              </button>
            </>
          )}

          {isIdle && (
            <>
              <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>{t("recording.guide.readyTitle")}</div>
              <div style={{ fontSize: 13.5, color: "var(--text-secondary)", maxWidth: 380 }}>
                {t("recording.guide.readyBody")}
              </div>
              <button
                onClick={() => startRecording()}
                style={{
                  background: "var(--accent)", color: "#fff", border: "none", borderRadius: 10,
                  padding: "10px 24px", cursor: "pointer", fontSize: 14, fontWeight: 600,
                  display: "inline-flex", alignItems: "center", gap: 8,
                }}
              >
                <MdMic size={18} /> {t("recording.guide.startRecording")}
              </button>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {t("recording.guide.importHint")}
              </div>
            </>
          )}
        </div>

        <TipsEditor />

        {isIdle && (
          <div style={{ display: "flex", justifyContent: "center" }}>
            <button
              onClick={() => navigate("/")}
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <MdCheckCircle size={15} /> {t("recording.guide.backHome")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
