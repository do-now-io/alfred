import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  MdMic, MdAutoAwesome, MdCheckCircle, MdFolderOpen, MdVpnKey,
  MdArrowBack, MdArrowForward, MdHourglassEmpty, MdWarning, MdDownload,
} from "react-icons/md";
import { useNotesStore } from "../store/notesStore";
import AlfredAvatar from "../components/AlfredAvatar";
import WhisperModelPicker from "../components/WhisperModelPicker";
import { detectSystemLang, useI18nStore, useT } from "../i18n";

// ─── Shared bits ────────────────────────────────────────────────────────────

const ACCENT = "var(--accent)";

function IconCircle({ children, tone = "accent" }: { children: React.ReactNode; tone?: "accent" | "dark" }) {
  return (
    <div
      style={{
        width: 72, height: 72, borderRadius: "50%",
        display: "flex", alignItems: "center", justifyContent: "center",
        border: `2px solid ${ACCENT}`,
        background: tone === "dark" ? "var(--dark-card)" : "var(--active-bg)",
        color: ACCENT, fontSize: 34, flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}

function Panel({ icon, title, text, children }: {
  icon: React.ReactNode; title: string; text: string; children?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 16 }}>
      {icon}
      <h2 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: "var(--text-primary)" }}>{title}</h2>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: "var(--text-secondary)", maxWidth: 460 }}>{text}</p>
      {children && <div style={{ width: "100%", maxWidth: 460, marginTop: 8 }}>{children}</div>}
    </div>
  );
}

const primaryBtn = (disabled = false): React.CSSProperties => ({
  background: disabled ? "var(--border)" : ACCENT,
  color: disabled ? "var(--text-secondary)" : "#fff",
  border: "none", borderRadius: 8, padding: "9px 18px",
  cursor: disabled ? "not-allowed" : "pointer", fontSize: 14, fontWeight: 500,
  display: "inline-flex", alignItems: "center", gap: 6,
});

const okRow: React.CSSProperties = {
  fontSize: 13, color: "#34C759", display: "flex", alignItems: "center", gap: 6,
};

const errorRow: React.CSSProperties = {
  fontSize: 13, color: "var(--danger)", display: "flex", alignItems: "center", gap: 6,
};

// ─── Setup steps ──────────────────────────────────────────────────────────────

function VaultStep() {
  const t = useT();
  const { vaultPath, fetchVaultPath, setVaultPath, pickVaultFolder } = useNotesStore();

  useEffect(() => { fetchVaultPath(); }, [fetchVaultPath]);

  const pick = async () => {
    const picked = await pickVaultFolder();
    if (picked) await setVaultPath(picked);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      <button onClick={pick} style={primaryBtn()}>
        <MdFolderOpen size={18} /> {t("onboarding.vault.chooseFolder")}
      </button>
      {vaultPath && (
        <div style={okRow}>
          <MdCheckCircle size={16} />
          <span style={{ color: "var(--text-secondary)", maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {vaultPath}
          </span>
        </div>
      )}
    </div>
  );
}

function ClaudeKeyStep() {
  const t = useT();
  const [value, setValue] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "ok" | "error">("idle");

  useEffect(() => {
    invoke<string | null>("get_secret", { account: "claude_api_key" }).then((v) => setHasKey(!!v));
  }, []);

  const save = async () => {
    if (!value.trim()) return;
    setState("saving");
    try {
      await invoke("save_secret", { account: "claude_api_key", value: value.trim() });
      await invoke("test_api_key", { service: "claude" });
      setHasKey(true);
      setValue("");
      setState("ok");
    } catch {
      setState("error");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="password"
          value={value}
          onChange={(e) => { setValue(e.target.value); setState("idle"); }}
          placeholder={hasKey ? t("onboarding.aiAccess.keyPlaceholderExisting") : t("onboarding.aiAccess.keyPlaceholderNew")}
          style={{
            flex: 1, border: "1px solid var(--border)", borderRadius: 8,
            padding: "9px 12px", fontSize: 14, background: "var(--card-bg)", color: "var(--text-primary)",
          }}
        />
        <button onClick={save} disabled={!value.trim() || state === "saving"} style={primaryBtn(!value.trim() || state === "saving")}>
          {state === "saving" ? <MdHourglassEmpty size={18} /> : <MdVpnKey size={18} />} {t("onboarding.aiAccess.validate")}
        </button>
      </div>
      {(state === "ok" || (hasKey && state === "idle")) && (
        <div style={okRow}><MdCheckCircle size={16} /> {state === "ok" ? t("onboarding.aiAccess.keySavedAndValidated") : t("onboarding.aiAccess.keySaved")}</div>
      )}
      {state === "error" && (
        <div style={errorRow}><MdWarning size={15} /> {t("onboarding.aiAccess.keyInvalid")}</div>
      )}
    </div>
  );
}

const modeBtn = (active: boolean): React.CSSProperties => ({
  flex: 1, padding: "8px 12px", borderRadius: 8, fontSize: 13.5, fontWeight: 500,
  cursor: "pointer", border: active ? `1.5px solid ${ACCENT}` : "1px solid var(--border)",
  background: active ? "var(--active-bg)" : "transparent",
  color: active ? ACCENT : "var(--text-secondary)",
});

function AiAccessStep() {
  const t = useT();
  const [mode, setMode] = useState<"byo" | "alfredia">("byo");
  const [subState, setSubState] = useState<"idle" | "subscribing" | "active" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const refreshSub = () => {
    invoke<string | null>("get_secret", { account: "alfredia_token" }).then((token) => {
      if (!token) return;
      invoke("test_api_key", { service: "alfredia" }).then(() => setSubState("active")).catch(() => {});
    });
  };

  useEffect(() => {
    invoke<string | null>("get_config", { key: "ai_mode" }).then((v) => { if (v === "alfredia") setMode("alfredia"); });
    refreshSub();
    let unsub: (() => void) | undefined;
    listen("alfredia-subscribed", () => { setSubState("active"); setMode("alfredia"); }).then((fn) => { unsub = fn; });
    return () => unsub?.();
  }, []);

  const changeMode = async (m: "byo" | "alfredia") => {
    setMode(m);
    await invoke("set_config", { key: "ai_mode", value: m });
  };

  const subscribe = async (plan: "monthly" | "yearly") => {
    setError(null);
    setSubState("subscribing");
    try {
      await invoke("subscribe_alfredia", { plan });
      setSubState("active");
    } catch (e) {
      setError(String(e));
      setSubState("error");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => changeMode("byo")} style={modeBtn(mode === "byo")}>{t("onboarding.aiAccess.myKey")}</button>
        <button onClick={() => changeMode("alfredia")} style={modeBtn(mode === "alfredia")}>{t("onboarding.aiAccess.subscription")}</button>
      </div>

      {mode === "byo" ? (
        <ClaudeKeyStep />
      ) : subState === "active" ? (
        <div style={{ ...okRow, justifyContent: "center" }}><MdCheckCircle size={16} /> {t("onboarding.aiAccess.subscribed")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <button onClick={() => subscribe("monthly")} disabled={subState === "subscribing"} style={primaryBtn(subState === "subscribing")}>
            {subState === "subscribing" ? <><MdHourglassEmpty size={18} /> {t("onboarding.aiAccess.awaitingPayment")}</> : t("onboarding.aiAccess.subscribeTrial")}
          </button>
          {subState !== "subscribing" && (
            <>
              <div style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
                {t("onboarding.aiAccess.thenPrice")}
              </div>
              <button onClick={() => subscribe("yearly")} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 8, padding: "7px 16px", cursor: "pointer", fontSize: 13, color: ACCENT }}>
                {t("onboarding.aiAccess.trialThenYearly")}
              </button>
            </>
          )}
          {error && <div style={errorRow}><MdWarning size={15} /> {error}</div>}
        </div>
      )}
    </div>
  );
}

function MicStep() {
  const t = useT();
  const [state, setState] = useState<"idle" | "testing" | "ok" | "error">("idle");

  const test = async () => {
    setState("testing");
    try {
      await invoke("test_microphone");
      setState("ok");
    } catch {
      setState("error");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      <button onClick={test} disabled={state === "testing"} style={primaryBtn(state === "testing")}>
        {state === "testing" ? <><MdHourglassEmpty size={18} /> {t("onboarding.mic.testing")}</> : <><MdMic size={18} /> {t("onboarding.mic.testMic")}</>}
      </button>
      {state === "ok" && <div style={okRow}><MdCheckCircle size={16} /> {t("onboarding.mic.micOk")}</div>}
      {state === "error" && (
        <div style={errorRow}><MdWarning size={15} /> {t("onboarding.mic.micDenied")}</div>
      )}
    </div>
  );
}

function LanguageStep() {
  const lang = useI18nStore((s) => s.lang);
  const setLang = useI18nStore((s) => s.setLang);

  const btn = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: "10px 14px", borderRadius: 8, fontSize: 14, fontWeight: 500,
    cursor: "pointer", border: active ? `1.5px solid ${ACCENT}` : "1px solid var(--border)",
    background: active ? "var(--active-bg)" : "transparent",
    color: active ? ACCENT : "var(--text-secondary)",
  });

  return (
    <div style={{ display: "flex", gap: 8, width: "100%" }}>
      <button onClick={() => setLang("fr")} style={btn(lang === "fr")}>Français</button>
      <button onClick={() => setLang("en")} style={btn(lang === "en")}>English</button>
    </div>
  );
}

// ─── Wizard ─────────────────────────────────────────────────────────────────

type Step = { name: string; node: React.ReactNode; skippable?: boolean };

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const t = useT();
  const setLang = useI18nStore((s) => s.setLang);
  const [step, setStep] = useState(0);
  const [finishing, setFinishing] = useState(false);
  // Téléchargement de modèle en cours (étape whisper_model, spec/13) : bloque
  // « Suivant » sur cette étape seulement — « Passer » reste possible et le
  // téléchargement continue en arrière-plan (événements par nom de modèle).
  const [downloadBusy, setDownloadBusy] = useState(false);

  // Pré-sélection de l'étape Langue (spec/21) : langue système si fr/en,
  // sinon en — mais seulement si `app_language` n'a JAMAIS été choisie
  // explicitement (install neuve). Un replay (« Revoir l'introduction ») sur
  // une install déjà configurée garde la langue déjà choisie.
  useEffect(() => {
    invoke<string | null>("get_config", { key: "app_language" }).then((v) => {
      if (v !== "fr" && v !== "en") setLang(detectSystemLang());
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const steps: Step[] = [
    {
      name: "language",
      node: (
        <Panel
          icon={<AlfredAvatar size={72} variant="minimal" />}
          title={t("onboarding.language.title")}
          text={t("onboarding.language.text")}
        >
          <LanguageStep />
        </Panel>
      ),
    },
    {
      name: "welcome",
      node: (
        <Panel
          icon={<AlfredAvatar size={84} variant="full" />}
          title={t("onboarding.welcome.title")}
          text={t("onboarding.welcome.text")}
        />
      ),
    },
    {
      name: "record_intro",
      node: (
        <Panel
          icon={<IconCircle><MdMic /></IconCircle>}
          title={t("onboarding.recordIntro.title")}
          text={t("onboarding.recordIntro.text")}
        />
      ),
    },
    {
      name: "whisper_model",
      skippable: true,
      node: (
        <Panel
          icon={<IconCircle><MdDownload /></IconCircle>}
          title={t("onboarding.whisperModel.title")}
          text={t("onboarding.whisperModel.text")}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ maxHeight: "min(300px, 38vh)", overflowY: "auto" }}>
              <WhisperModelPicker onBusyChange={setDownloadBusy} />
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {t("onboarding.whisperModel.warning")}
            </div>
          </div>
        </Panel>
      ),
    },
    {
      name: "ingest_intro",
      node: (
        <Panel
          icon={<IconCircle><MdAutoAwesome /></IconCircle>}
          title={t("onboarding.ingestIntro.title")}
          text={t("onboarding.ingestIntro.text")}
        />
      ),
    },
    {
      name: "vault",
      skippable: true,
      node: (
        <Panel
          icon={<IconCircle><MdFolderOpen /></IconCircle>}
          title={t("onboarding.vault.title")}
          text={t("onboarding.vault.text")}
        >
          <VaultStep />
        </Panel>
      ),
    },
    {
      name: "ai_access",
      skippable: true,
      node: (
        <Panel
          icon={<IconCircle><MdVpnKey /></IconCircle>}
          title={t("onboarding.aiAccess.title")}
          text={t("onboarding.aiAccess.text")}
        >
          <AiAccessStep />
        </Panel>
      ),
    },
    {
      name: "mic",
      skippable: true,
      node: (
        <Panel
          icon={<IconCircle tone="dark"><MdMic /></IconCircle>}
          title={t("onboarding.mic.title")}
          text={t("onboarding.mic.text")}
        >
          <MicStep />
        </Panel>
      ),
    },
    {
      name: "ready",
      node: (
        <Panel
          icon={<IconCircle><MdCheckCircle /></IconCircle>}
          title={t("onboarding.ready.title")}
          text={t("onboarding.ready.text")}
        />
      ),
    },
  ];

  const total = steps.length;
  const isLast = step === total - 1;
  const current = steps[step];
  // « Suivant » gelé pendant un téléchargement, uniquement sur l'étape modèle
  // (« Passer » reste actif — spec/13).
  const nextDisabled = finishing || (downloadBusy && current.name === "whisper_model");

  // Entonnoir d'onboarding (metrics, spec/15 §D) : un event par étape vue —
  // permet de voir où les gens décrochent, en comparant au max `step` atteint
  // par install avant `onboarding_finished` (ou son absence).
  useEffect(() => {
    invoke("track_event", { event: "onboarding_step_shown", props: { step, name: current.name } }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const finish = async () => {
    setFinishing(true);
    try { await invoke("set_config", { key: "onboarding_completed", value: "true" }); }
    catch { /* non-fatal */ }
    // Contenu de démarrage (spec/13) : tâches checklist, notes de démo,
    // conversation d'exemple — pour que la visite (et l'arrivée hors visite) ait
    // de la matière. Idempotent côté backend (flag `starter_content_seeded`).
    try { await invoke("seed_starter_content"); }
    catch { /* non-fatal */ }
    invoke("track_event", { event: "onboarding_finished", props: {} }).catch(() => {});
    onDone();
  };

  const next = () => (isLast ? finish() : setStep((s) => Math.min(s + 1, total - 1)));
  const back = () => setStep((s) => Math.max(s - 1, 0));
  const skipStep = () => {
    invoke("track_event", { event: "onboarding_step_skipped", props: { step, name: current.name } }).catch(() => {});
    next();
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 2000,
      background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center",
      padding: 24,
    }}>
      <div className="card" style={{
        width: "100%", maxWidth: 640, padding: "32px 36px",
        display: "flex", flexDirection: "column", gap: 28,
        boxShadow: "0 12px 48px rgba(0,0,0,0.18)",
      }}>
        {/* Progress dots */}
        <div style={{ display: "flex", justifyContent: "center", gap: 7 }}>
          {steps.map((_, i) => (
            <span
              key={i}
              style={{
                width: i === step ? 22 : 7, height: 7, borderRadius: 4,
                background: i === step ? ACCENT : "var(--border)",
                transition: "all 0.2s",
              }}
            />
          ))}
        </div>

        {/* Content */}
        <div style={{ minHeight: 280, display: "flex", alignItems: "center", justifyContent: "center", padding: "8px 0" }}>
          {current.node}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button
            onClick={back}
            disabled={step === 0}
            style={{
              background: "none", border: "none", cursor: step === 0 ? "default" : "pointer",
              color: step === 0 ? "transparent" : "var(--text-secondary)",
              fontSize: 14, display: "inline-flex", alignItems: "center", gap: 4,
            }}
          >
            <MdArrowBack size={16} /> {t("common.previous")}
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {current.skippable && !isLast && (
              <button
                onClick={skipStep}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 14 }}
              >
                {t("common.skip")}
              </button>
            )}
            <button onClick={next} disabled={nextDisabled} style={primaryBtn(nextDisabled)}>
              {isLast ? t("common.start") : <>{t("common.next")} <MdArrowForward size={16} /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
