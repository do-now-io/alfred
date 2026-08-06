import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  MdMic, MdAutoAwesome, MdCheckCircle, MdFolderOpen, MdVpnKey,
  MdArrowBack, MdArrowForward, MdHourglassEmpty, MdWarning, MdDownload,
  MdMail, MdSettingsEthernet, MdOpenInNew,
} from "react-icons/md";
import { SiGmail, SiIcloud } from "react-icons/si";
import { useNotesStore } from "../store/notesStore";
import AlfredAvatar from "../components/AlfredAvatar";
import WhisperModelPicker from "../components/WhisperModelPicker";
import { detectSystemLang, useI18nStore, useT } from "../i18n";
import type { ImapStatus } from "../bindings/ImapStatus";

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

const inputStyle: React.CSSProperties = {
  border: "1px solid var(--border)", borderRadius: 8, padding: "9px 12px",
  fontSize: 14, background: "var(--card-bg)", color: "var(--text-primary)",
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

// ─── E-mails (spec/24) — connexion IMAP guidée par fournisseur ────────────────
// Sélection d'un fournisseur connu → pré-remplit host/port/SSL + affiche le
// lien direct vers la page de génération du mot de passe d'application de ce
// fournisseur (Gmail/Outlook/Yahoo/iCloud bloquent IMAP avec le mot de passe
// du compte). « Autre » laisse le host en saisie libre (IMAP générique).

type EmailProvider = {
  id: string;
  label: string;
  host: string;
  port: number;
  useSsl: boolean;
  helpUrl: string | null;
  icon: React.ReactNode;
};

const EMAIL_PROVIDERS: EmailProvider[] = [
  { id: "gmail", label: "Gmail", host: "imap.gmail.com", port: 993, useSsl: true, helpUrl: "https://myaccount.google.com/apppasswords", icon: <SiGmail /> },
  { id: "outlook", label: "Outlook / Microsoft 365", host: "outlook.office365.com", port: 993, useSsl: true, helpUrl: "https://account.live.com/proofs/AppPassword", icon: <MdMail /> },
  { id: "yahoo", label: "Yahoo Mail", host: "imap.mail.yahoo.com", port: 993, useSsl: true, helpUrl: "https://login.yahoo.com/myaccount/security/app-passwords", icon: <MdMail /> },
  { id: "icloud", label: "iCloud Mail", host: "imap.mail.me.com", port: 993, useSsl: true, helpUrl: "https://appleid.apple.com/account/manage", icon: <SiIcloud /> },
  { id: "other", label: "IMAP générique", host: "", port: 993, useSsl: true, helpUrl: null, icon: <MdSettingsEthernet /> },
];

async function openExternal(url: string) {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch {
    /* best-effort — pas de note système sur un lien externe qui échoue */
  }
}

function EmailStep() {
  const t = useT();
  const [status, setStatus] = useState<ImapStatus | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [useSsl, setUseSsl] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<ImapStatus>("get_imap_status").then(setStatus).catch(() => setStatus(null));
  }, []);

  const pickProvider = (p: EmailProvider) => {
    setProviderId(p.id);
    setHost(p.host);
    setPort(String(p.port));
    setUseSsl(p.useSsl);
    setError(null);
  };

  const handleConnect = async () => {
    setError(null);
    setConnecting(true);
    try {
      await invoke("connect_imap_account", { host, port: Number(port) || 993, username, password, useSsl });
      setPassword("");
      setStatus({ connected: true, last_synced_at: null });
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  };

  if (status?.connected) {
    return (
      <div style={{ ...okRow, justifyContent: "center" }}>
        <MdCheckCircle size={16} /> {t("onboarding.email.connected")}
      </div>
    );
  }

  const provider = EMAIL_PROVIDERS.find((p) => p.id === providerId) ?? null;
  const canConnect = !connecting && host.trim() && username.trim() && password.trim();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {EMAIL_PROVIDERS.map((p) => (
          <button key={p.id} onClick={() => pickProvider(p)} style={modeBtn(providerId === p.id)}>
            <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              {p.icon} {p.label}
            </span>
          </button>
        ))}
      </div>

      {provider && (
        <>
          {provider.helpUrl && (
            <div style={{
              display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5,
              color: "var(--text-secondary)", background: "var(--active-bg)",
              borderRadius: 8, padding: "9px 12px", textAlign: "left",
            }}>
              <span>{t(`onboarding.email.help.${provider.id}`)}</span>
              <button
                onClick={() => openExternal(provider.helpUrl!)}
                style={{
                  alignSelf: "flex-start", background: "none", border: "1px solid var(--border)",
                  borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12,
                  color: ACCENT, display: "inline-flex", alignItems: "center", gap: 5,
                }}
              >
                {t("onboarding.email.openHelpLink")} <MdOpenInNew size={13} />
              </button>
            </div>
          )}

          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t("settings.emailSection.username")}
            style={inputStyle}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("settings.emailSection.password")}
            style={inputStyle}
          />

          {provider.id === "other" && (
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder={t("settings.emailSection.host")}
                style={{ ...inputStyle, flex: 1 }}
              />
              <input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder={t("settings.emailSection.port")}
                style={{ ...inputStyle, width: 80 }}
              />
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-primary)", flexShrink: 0 }}>
                <input type="checkbox" checked={useSsl} onChange={(e) => setUseSsl(e.target.checked)} />
                SSL
              </label>
            </div>
          )}

          <button onClick={handleConnect} disabled={!canConnect} style={primaryBtn(!canConnect)}>
            {connecting ? <><MdHourglassEmpty size={18} /> {t("settings.emailSection.connecting")}</> : <><MdMail size={18} /> {t("settings.emailSection.connect")}</>}
          </button>
          {error && <div style={errorRow}><MdWarning size={15} /> {error}</div>}
        </>
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
      name: "email",
      skippable: true,
      node: (
        <Panel
          icon={<IconCircle><MdMail /></IconCircle>}
          title={t("onboarding.email.title")}
          text={t("onboarding.email.text")}
        >
          <EmailStep />
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
          icon={<AlfredAvatar size={72} variant="full" />}
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

  // Entonnoir d'onboarding (metrics, backend privé alfred-backend §D) : un event par étape vue —
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
