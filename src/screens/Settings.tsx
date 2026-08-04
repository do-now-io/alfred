import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useNotesStore } from "../store/notesStore";
import { usePendingEmailReviewStore } from "../store/pendingEmailReviewStore";
import { useTourStore } from "../store/tourStore";
import { useProfileStore } from "../store/profileStore";
import { useUpdateStore } from "../store/updateStore";
import WhisperModelPicker from "../components/WhisperModelPicker";
import type { NoteFile } from "../bindings/NoteFile";
import type { ImapStatus } from "../bindings/ImapStatus";
import type { GoogleAuthStatus } from "../bindings/GoogleAuthStatus";
import { useI18nStore, useT, type Lang } from "../i18n";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: 12,
          paddingBottom: 6,
          borderBottom: "1px solid var(--border)",
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function SettingRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 12,
        gap: 16,
      }}
    >
      <span style={{ fontSize: 14, color: "var(--text-primary)", flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

/** Profil local (spec/10/11, feedback tests) : prénom + avatar — aucun compte
 *  serveur, remplace le menu profil ambigu retiré de la topbar (spec/10). */
function ProfileSection() {
  const t = useT();
  const { name, avatar, load, setName, setAvatar } = useProfileStore();
  const [draftName, setDraftName] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setDraftName(name); }, [name]);

  const pickAvatar = () => fileInput.current?.click();

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setAvatar(reader.result as string);
    reader.readAsDataURL(file);
  };

  const initial = draftName.trim().charAt(0).toUpperCase() || "?";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
      <button
        onClick={pickAvatar}
        title={t("settings.profile.changeAvatar")}
        style={{
          width: 52, height: 52, borderRadius: "50%", flexShrink: 0,
          border: "1.5px solid var(--accent)", background: avatar ? "none" : "#1C1C1C",
          cursor: "pointer", padding: 0, overflow: "hidden",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        {avatar ? (
          <img src={avatar} alt="Avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <span style={{ color: "var(--accent)", fontSize: 18, fontWeight: 600 }}>{initial}</span>
        )}
      </button>
      <input ref={fileInput} type="file" accept="image/*" onChange={onFile} style={{ display: "none" }} />
      <div style={{ flex: 1 }}>
        <input
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={() => { if (draftName.trim() !== name) setName(draftName.trim()); }}
          placeholder={t("settings.profile.namePlaceholder")}
          style={{
            width: "100%", border: "1px solid var(--border)", borderRadius: 8,
            padding: "8px 11px", fontSize: 14, background: "var(--bg)", color: "var(--text-primary)",
            boxSizing: "border-box",
          }}
        />
        <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 5 }}>
          {t("settings.profile.nameHelp")}
        </div>
      </div>
    </div>
  );
}

function SecretInput({
  account,
  label,
  onTest,
}: {
  account: string;
  label: string;
  onTest?: () => Promise<void>;
}) {
  const t = useT();
  const [value, setValue] = useState("••••••••••");
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "error" | null>(null);

  useEffect(() => {
    invoke<string | null>("get_secret", { account }).then((v) => {
      if (v) setValue("••••••••••");
      else setValue("");
    });
  }, [account]);

  const handleSave = async () => {
    if (!editValue.trim()) return;
    await invoke("save_secret", { account, value: editValue });
    setValue("••••••••••");
    setEditing(false);
    setEditValue("");
    setTestResult(null);
  };

  const handleTest = async () => {
    if (!onTest) return;
    setTesting(true);
    setTestResult(null);
    try {
      await onTest();
      setTestResult("ok");
    } catch {
      setTestResult("error");
    } finally {
      setTesting(false);
    }
  };

  if (editing) {
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          autoFocus
          type="password"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          placeholder={label}
          style={{
            flex: 1,
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "5px 10px",
            fontSize: 13,
            background: "var(--card-bg)",
            color: "var(--text-primary)",
          }}
        />
        <button
          onClick={handleSave}
          style={{
            background: "var(--accent)",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            padding: "5px 12px",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          {t("settings.secret.save")}
        </button>
        <button
          onClick={() => setEditing(false)}
          style={{
            background: "transparent",
            color: "var(--text-secondary)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "5px 12px",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          {t("settings.secret.cancel")}
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span
        style={{
          fontSize: 13,
          color: value ? "var(--text-primary)" : "var(--text-secondary)",
          letterSpacing: value === "••••••••••" ? "0.1em" : "normal",
        }}
      >
        {value || t("settings.secret.notSet")}
      </span>
      <button
        onClick={() => setEditing(true)}
        style={{
          background: "transparent",
          color: "var(--accent)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "4px 10px",
          cursor: "pointer",
          fontSize: 12,
        }}
      >
        {t("settings.secret.edit")}
      </button>
      {onTest && value === "••••••••••" && (
        <button
          onClick={handleTest}
          disabled={testing}
          style={{
            background: "transparent",
            color: testing ? "var(--text-secondary)" : "var(--text-primary)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "4px 10px",
            cursor: testing ? "not-allowed" : "pointer",
            fontSize: 12,
          }}
        >
          {testing ? t("settings.secret.testing") : t("settings.secret.test")}
        </button>
      )}
      {testResult === "ok" && <span style={{ color: "#34C759", fontSize: 12 }}>✓ {t("settings.secret.ok")}</span>}
      {testResult === "error" && <span style={{ color: "var(--danger)", fontSize: 12 }}>✗ {t("settings.secret.error")}</span>}
    </div>
  );
}

// ─── AI access section (personal key / AlfredIA subscription) ──────────────────
// Two modes (spec/05, backend privé alfred-backend): "byo" = user's own Anthropic key, "alfredia" =
// our subscription proxy. Subscribing opens Stripe Checkout in the browser; the
// token comes back via loopback (subscribe_alfredia) — zero copy-paste.

function AiAccessSection() {
  const t = useT();
  const [mode, setMode] = useState<string>("byo");
  const [subStatus, setSubStatus] = useState<"unknown" | "none" | "active" | "error">("unknown");
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);

  const refreshSub = useCallback(() => {
    invoke<string | null>("get_secret", { account: "alfredia_token" }).then((t) => {
      if (!t) {
        setSubStatus("none");
        return;
      }
      invoke("test_api_key", { service: "alfredia" })
        .then(() => setSubStatus("active"))
        .catch(() => setSubStatus("error"));
    });
  }, []);

  useEffect(() => {
    invoke<string | null>("get_config", { key: "ai_mode" }).then((v) => v && setMode(v));
    refreshSub();
    let unsub: (() => void) | undefined;
    listen("alfredia-subscribed", () => {
      setSubscribing(false);
      setMode("alfredia");
      refreshSub();
    }).then((fn) => (unsub = fn));
    return () => unsub?.();
  }, [refreshSub]);

  const changeMode = async (m: string) => {
    setMode(m);
    await invoke("set_config", { key: "ai_mode", value: m });
  };

  const handleSubscribe = async (plan: "monthly" | "yearly") => {
    setError(null);
    setSubscribing(true);
    try {
      await invoke("subscribe_alfredia", { plan });
      // Success path also handled by the "alfredia-subscribed" event.
      setSubscribing(false);
      refreshSub();
    } catch (e) {
      setError(String(e));
      setSubscribing(false);
    }
  };

  const handleManage = async () => {
    setError(null);
    setManaging(true);
    try {
      await invoke("manage_alfredia_subscription");
    } catch (e) {
      setError(String(e));
    } finally {
      setManaging(false);
    }
  };

  const radio = (value: string, label: string) => (
    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, color: "var(--text-primary)", cursor: "pointer" }}>
      <input type="radio" name="ai_mode" checked={mode === value} onChange={() => changeMode(value)} />
      {label}
    </label>
  );

  return (
    <>
      <div style={{ display: "flex", gap: 20, marginBottom: 14 }}>
        {radio("byo", t("settings.aiAccessSection.myKey"))}
        {radio("alfredia", t("settings.aiAccessSection.subscription"))}
      </div>

      {mode === "byo" && (
        <SettingRow label={t("settings.aiAccessSection.claudeApiKey")}>
          <SecretInput
            account="claude_api_key"
            label="sk-ant-..."
            onTest={() => invoke("test_api_key", { service: "claude" })}
          />
        </SettingRow>
      )}

      {mode === "alfredia" && (
        <SettingRow label={t("settings.aiAccessSection.subscriptionLabel")}>
          {subStatus === "active" ? (
            <>
              <span style={{ fontSize: 13, color: "#34C759" }}>✓ {t("settings.aiAccessSection.active")}</span>
              <button
                onClick={handleManage}
                disabled={managing}
                title={t("settings.aiAccessSection.manageHelp")}
                style={{
                  marginLeft: 10,
                  background: "transparent",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "4px 10px",
                  cursor: managing ? "not-allowed" : "pointer",
                  fontSize: 12.5,
                }}
              >
                {managing ? t("settings.aiAccessSection.manageOpening") : t("settings.aiAccessSection.manage")}
              </button>
            </>
          ) : (
            <>
              {subStatus === "error" && (
                <span style={{ fontSize: 12, color: "var(--danger)" }}>{t("settings.aiAccessSection.inactive")}</span>
              )}
              <button
                onClick={() => handleSubscribe("monthly")}
                disabled={subscribing}
                style={{
                  background: "var(--accent)",
                  color: "#fff",
                  border: "none",
                  borderRadius: 6,
                  padding: "5px 12px",
                  cursor: subscribing ? "not-allowed" : "pointer",
                  fontSize: 13,
                }}
              >
                {subscribing ? t("settings.aiAccessSection.awaitingPayment") : t("settings.aiAccessSection.subscribeTrial")}
              </button>
              {!subscribing && (
                <button
                  onClick={() => handleSubscribe("yearly")}
                  style={{
                    background: "transparent",
                    color: "var(--accent)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: "5px 12px",
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  {t("settings.aiAccessSection.trialThenYearly")}
                </button>
              )}
            </>
          )}
        </SettingRow>
      )}
      {mode === "alfredia" && subStatus !== "active" && !subscribing && (
        <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 4 }}>
          {t("settings.aiAccessSection.thenPrice")}
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 4 }}>{error}</div>}
    </>
  );
}

// ─── E-mails (spec/24) — connexion IMAP + sync manuelle ────────────────────────

function EmailSection() {
  const t = useT();
  const navigate = useNavigate();
  const pendingReviewCount = usePendingEmailReviewStore((s) => s.count);
  const [status, setStatus] = useState<ImapStatus | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [useSsl, setUseSsl] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    invoke<ImapStatus>("get_imap_status").then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleConnect = async () => {
    setError(null);
    setConnecting(true);
    try {
      await invoke("connect_imap_account", { host, port: Number(port) || 993, username, password, useSsl });
      setPassword("");
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    await invoke("disconnect_imap_account");
    setHost("");
    setUsername("");
    setPassword("");
    refresh();
  };

  const handleSync = async () => {
    setError(null);
    setSyncing(true);
    try {
      await invoke("sync_emails");
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  };

  if (status?.connected) {
    return (
      <>
        <SettingRow label={t("settings.emailSection.status")}>
          <span style={{ fontSize: 13, color: "#34C759" }}>✓ {t("settings.emailSection.connected")}</span>
        </SettingRow>
        <SettingRow label={t("settings.emailSection.lastSync")}>
          <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
            {status.last_synced_at ? new Date(status.last_synced_at).toLocaleString() : t("settings.emailSection.never")}
          </span>
        </SettingRow>
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button
            onClick={handleSync}
            disabled={syncing}
            style={{
              background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6,
              padding: "5px 12px", cursor: syncing ? "not-allowed" : "pointer", fontSize: 13,
            }}
          >
            {syncing ? t("settings.emailSection.syncing") : t("settings.emailSection.syncNow")}
          </button>
          <button
            onClick={handleDisconnect}
            style={{
              background: "transparent", color: "var(--danger)", border: "1px solid var(--border)",
              borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 13,
            }}
          >
            {t("settings.emailSection.disconnect")}
          </button>
        </div>
        {/* Badge de notification (spec/24 §5) — propositions issues des mails
            en attente de validation, ici en plus du badge global de la
            sidebar (emplacement le plus proche de la connexion IMAP). */}
        {pendingReviewCount > 0 && (
          <button
            onClick={() => navigate("/resolve-emails")}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8,
              background: "var(--active-bg)", color: "var(--accent)", border: "1px solid var(--accent)",
              borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 12.5, fontWeight: 600,
            }}
          >
            {t(pendingReviewCount > 1 ? "settings.emailSection.reviewPendingPlural" : "settings.emailSection.reviewPending", { count: pendingReviewCount })}
          </button>
        )}
        {error && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>{error}</div>}
      </>
    );
  }

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
        <input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder={t("settings.emailSection.host")}
          style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", fontSize: 13, background: "var(--card-bg)", color: "var(--text-primary)" }}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder={t("settings.emailSection.port")}
            style={{ width: 90, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", fontSize: 13, background: "var(--card-bg)", color: "var(--text-primary)" }}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-primary)" }}>
            <input type="checkbox" checked={useSsl} onChange={(e) => setUseSsl(e.target.checked)} />
            {t("settings.emailSection.useSsl")}
          </label>
        </div>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t("settings.emailSection.username")}
          style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", fontSize: 13, background: "var(--card-bg)", color: "var(--text-primary)" }}
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("settings.emailSection.password")}
          style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", fontSize: 13, background: "var(--card-bg)", color: "var(--text-primary)" }}
        />
      </div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 10 }}>
        {t("settings.emailSection.help")}
      </div>
      <button
        onClick={handleConnect}
        disabled={connecting || !host.trim() || !username.trim() || !password.trim()}
        style={{
          background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6,
          padding: "5px 12px", cursor: connecting ? "not-allowed" : "pointer", fontSize: 13,
        }}
      >
        {connecting ? t("settings.emailSection.connecting") : t("settings.emailSection.connect")}
      </button>
      {error && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>{error}</div>}
    </>
  );
}

// ─── Google Calendar (spec/02) — OAuth + sync manuelle ────────────────────────

function CalendarSection() {
  const t = useT();
  const [status, setStatus] = useState<GoogleAuthStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    invoke<GoogleAuthStatus>("get_calendar_auth_status").then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleConnect = async () => {
    setError(null);
    setConnecting(true);
    try {
      await invoke("start_google_oauth");
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    await invoke("disconnect_google_calendar");
    refresh();
  };

  const handleSync = async () => {
    setError(null);
    setSyncing(true);
    try {
      await invoke("trigger_calendar_sync");
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <SettingRow label={t("settings.calendarSection.status")}>
        <span style={{ fontSize: 13, color: status?.connected ? "#34C759" : "var(--text-secondary)" }}>
          {status?.connected ? `✓ ${t("settings.calendarSection.connected")}` : t("settings.calendarSection.notConnected")}
        </span>
      </SettingRow>
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        {status?.connected ? (
          <>
            <button
              onClick={handleSync}
              disabled={syncing}
              style={{
                background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6,
                padding: "5px 12px", cursor: syncing ? "not-allowed" : "pointer", fontSize: 13,
              }}
            >
              {syncing ? t("settings.calendarSection.syncing") : t("settings.calendarSection.syncNow")}
            </button>
            <button
              onClick={handleDisconnect}
              style={{
                background: "transparent", color: "var(--danger)", border: "1px solid var(--border)",
                borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 13,
              }}
            >
              {t("settings.calendarSection.disconnect")}
            </button>
          </>
        ) : (
          <button
            onClick={handleConnect}
            disabled={connecting}
            style={{
              background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6,
              padding: "5px 12px", cursor: connecting ? "not-allowed" : "pointer", fontSize: 13,
            }}
          >
            {connecting ? t("settings.calendarSection.connecting") : t("settings.calendarSection.connect")}
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5, marginTop: 10 }}>
        {t("settings.calendarSection.help")}
      </div>
      {!status?.connected && (
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, marginTop: 6 }}>
          {t("settings.calendarSection.unverifiedWarning")}
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>{error}</div>}
    </>
  );
}

// ─── Settings screen ──────────────────────────────────────────────────────────

export default function Settings() {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const setLang = useI18nStore((s) => s.setLang);
  const navigate = useNavigate();
  const [languageHint, setLanguageHint] = useState("auto");
  const [recordingSource, setRecordingSource] = useState("mixed");
  const [launchAtLogin, setLaunchAtLogin] = useState(false);

  useEffect(() => {
    invoke<string | null>("get_config", { key: "language_hint" }).then((v) => v && setLanguageHint(v));
    invoke<string | null>("get_config", { key: "recording_source" }).then((v) => v && setRecordingSource(v));
    invoke<boolean>("get_launch_at_login").catch(() => false).then((v) => setLaunchAtLogin(v));
  }, []);

  const setConfig = async (key: string, value: string) => {
    await invoke("set_config", { key, value });
  };

  const handleLaunchAtLoginChange = async (enabled: boolean) => {
    setLaunchAtLogin(enabled);
    await invoke("set_launch_at_login", { enabled });
  };

  return (
    <div style={{ padding: 32, maxWidth: 600, overflowY: "auto", height: "100%" }}>
      <h1 style={{ margin: "0 0 28px", fontSize: 22, fontWeight: 600, color: "var(--text-primary)" }}>
        {t("settings.title")}
      </h1>

      <Section title={t("settings.sections.profile")}>
        <ProfileSection />
      </Section>

      <Section title={t("settings.sections.aiAccess")}>
        <AiAccessSection />
      </Section>

      <Section title={t("settings.sections.recording")}>
        <SettingRow label={t("settings.recordingSection.audioSource")}>
          <select
            className="alfred-select"
            value={recordingSource}
            onChange={(e) => {
              setRecordingSource(e.target.value);
              setConfig("recording_source", e.target.value);
            }}
          >
            <option value="mic_only">{t("settings.recordingSection.micOnly")}</option>
            <option value="system_only">{t("settings.recordingSection.systemOnly")}</option>
            <option value="mixed">{t("settings.recordingSection.mixed")}</option>
          </select>
        </SettingRow>
        <SettingRow label={t("settings.recordingSection.recordingsFolder")}>
          <FolderConfigRow
            configKey="recording_folder"
            defaultValue="alfred-raw"
            load={() => invoke<string>("get_recording_folder")}
          />
        </SettingRow>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {t("settings.recordingSection.recordingsFolderHelp")} <code>alfred-raw</code>
        </div>
      </Section>

      <Section title={t("settings.sections.notes")}>
        <VaultPathRow />
        <SettingRow label={t("settings.notesSection.newNoteFolder")}>
          <FolderConfigRow
            configKey="new_note_folder"
            defaultValue="alfred-raw"
            load={async () =>
              (await invoke<string | null>("get_config", { key: "new_note_folder" })) || "alfred-raw"
            }
          />
        </SettingRow>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 12 }}>
          {t("settings.notesSection.newNoteFolderHelp")} <code>alfred-raw</code>
        </div>
        <ContextNoteRow />
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {t("settings.notesSection.contextHelp")}
        </div>
      </Section>

      <Section title={t("settings.sections.emails")}>
        <EmailSection />
      </Section>

      <Section title={t("settings.sections.calendar")}>
        <CalendarSection />
      </Section>

      <Section title={t("settings.sections.tasks")}>
        <SettingRow label={t("settings.tasksSection.todoFile")}>
          <TodoFileRow />
        </SettingRow>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {t("settings.tasksSection.todoFileHelp")} <code>alfred-intelligence/Todo.md</code>
        </div>
      </Section>

      <Section title={t("settings.sections.system")}>
        <SettingRow label={t("settings.systemSection.launchAtLogin")}>
          <input
            type="checkbox"
            checked={launchAtLogin}
            onChange={(e) => handleLaunchAtLoginChange(e.target.checked)}
            style={{ cursor: "pointer" }}
          />
        </SettingRow>
        <SettingRow label={t("settings.systemSection.introduction")}>
          <button
            onClick={() => {
              sessionStorage.setItem("alfred_force_onboarding", "1");
              window.location.reload();
            }}
            style={{
              background: "transparent", color: "var(--accent)",
              border: "1px solid var(--border)", borderRadius: 6,
              padding: "4px 10px", cursor: "pointer", fontSize: 12,
            }}
          >
            {t("settings.systemSection.reviewIntroduction")}
          </button>
        </SettingRow>
        <SettingRow label={t("settings.systemSection.guidedTour")}>
          <button
            onClick={() => {
              navigate("/");
              useTourStore.getState().start();
            }}
            style={{
              background: "transparent", color: "var(--accent)",
              border: "1px solid var(--border)", borderRadius: 6,
              padding: "4px 10px", cursor: "pointer", fontSize: 12,
            }}
          >
            {t("settings.systemSection.reviewGuidedTour")}
          </button>
        </SettingRow>
        <UpdateCheckRow />
      </Section>

      {/* Tout en bas (feedback Tanguy) : le gestionnaire de modèles est la
          section la plus haute visuellement, elle écrasait le reste en tête. */}
      <Section title={t("settings.sections.transcription")}>
        {/* Gestionnaire de modèles Whisper (spec/04/11) : même composant que
            l'étape d'onboarding. « Utiliser » n'existe que sur un modèle
            téléchargé, on ne peut plus activer un modèle absent du disque. */}
        <div style={{ marginBottom: 14 }}>
          <WhisperModelPicker />
        </div>
        <SettingRow label={t("settings.transcriptionSection.appLanguage")}>
          <select
            className="alfred-select"
            value={lang}
            onChange={(e) => setLang(e.target.value as Lang)}
          >
            <option value="fr">Français</option>
            <option value="en">English</option>
          </select>
        </SettingRow>
        <SettingRow label={t("settings.transcriptionSection.language")}>
          <select
            className="alfred-select"
            value={languageHint}
            onChange={(e) => {
              setLanguageHint(e.target.value);
              setConfig("language_hint", e.target.value);
            }}
          >
            <option value="auto">{t("settings.transcriptionSection.autoDetect")}</option>
            <option value="fr">Français</option>
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="de">Deutsch</option>
          </select>
        </SettingRow>
      </Section>
    </div>
  );
}

/** Entrée manuelle « Vérifier les mises à jour » (spec/27) — relance `check()`
 *  sans attendre le prochain démarrage. Le check silencieux au lancement de
 *  l'app vit dans `App.tsx` (useUpdateStore.checkForUpdate) ; ce bouton
 *  réutilise le même store, donc une mise à jour trouvée ici affiche aussi le
 *  bandeau global. */
function UpdateCheckRow() {
  const t = useT();
  const status = useUpdateStore((s) => s.status);
  const info = useUpdateStore((s) => s.info);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);

  return (
    <SettingRow label={t("settings.systemSection.checkUpdates")}>
      {status === "up_to_date" && (
        <span style={{ fontSize: 12, color: "#34C759" }}>✓ {t("settings.systemSection.upToDate")}</span>
      )}
      {status === "available" && info && (
        <span style={{ fontSize: 12, color: "var(--accent)" }}>
          {t("settings.systemSection.updateAvailable", { version: info.version })}
        </span>
      )}
      {status === "error" && (
        <span style={{ fontSize: 12, color: "var(--danger)" }}>{t("settings.systemSection.checkError")}</span>
      )}
      <button
        onClick={() => checkForUpdate()}
        disabled={status === "checking"}
        style={{
          background: "transparent", color: "var(--accent)",
          border: "1px solid var(--border)", borderRadius: 6,
          padding: "4px 10px", cursor: status === "checking" ? "not-allowed" : "pointer", fontSize: 12,
        }}
      >
        {status === "checking" ? t("settings.systemSection.checking") : t("settings.systemSection.checkUpdates")}
      </button>
    </SettingRow>
  );
}

function VaultPathRow() {
  const t = useT();
  const { vaultPath, fetchVaultPath, setVaultPath, pickVaultFolder } = useNotesStore();

  useEffect(() => { fetchVaultPath(); }, [fetchVaultPath]);

  const handlePick = async () => {
    const picked = await pickVaultFolder();
    if (picked) await setVaultPath(picked);
  };

  const displayPath = vaultPath
    ? (vaultPath.length > 40 ? "…" + vaultPath.slice(-40) : vaultPath)
    : t("settings.notesSection.notConfigured");

  return (
    <SettingRow label={t("settings.notesSection.vaultFolder")}>
      <span style={{ fontSize: 12, color: vaultPath ? "var(--text-primary)" : "var(--text-muted)", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {displayPath}
      </span>
      <button
        onClick={handlePick}
        style={{
          background: "var(--accent)", color: "#fff", border: "none",
          borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 13,
        }}
      >
        {t("settings.notesSection.choose")}
      </button>
    </SettingRow>
  );
}

function ContextNoteRow() {
  const t = useT();
  const navigate = useNavigate();
  const { selectFile } = useNotesStore();
  const [glossaryState, setGlossaryState] = useState<
    { kind: "idle" } | { kind: "loading" } | { kind: "done"; terms: number } | { kind: "error"; message: string }
  >({ kind: "idle" });

  const handleOpen = async () => {
    try {
      const note = await invoke<NoteFile>("open_context_note");
      await selectFile(note.path);
      navigate("/notes");
    } catch (e) {
      console.error("[settings] open_context_note failed:", e);
    }
  };

  // Derive the Whisper glossary from Contexte Alfred.md (spec/17 §1). Corrects
  // proper nouns at the source on the next recordings.
  const handleRegenGlossary = async () => {
    setGlossaryState({ kind: "loading" });
    try {
      const glossary = await invoke<string>("generate_glossary_from_context");
      // Rough term count from the comma-separated list (info only).
      const terms = glossary.trim() ? glossary.split(",").length : 0;
      setGlossaryState({ kind: "done", terms });
    } catch (e) {
      setGlossaryState({ kind: "error", message: String(e) });
    }
  };

  const btnStyle = {
    background: "transparent", color: "var(--accent)",
    border: "1px solid var(--border)", borderRadius: 6,
    padding: "4px 10px", cursor: "pointer", fontSize: 12,
  } as const;

  return (
    <SettingRow label={t("settings.notesSection.context")}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
        {glossaryState.kind === "done" && (
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {glossaryState.terms > 0 ? t("settings.notesSection.glossaryTerms", { count: glossaryState.terms }) : t("settings.notesSection.emptyContext")}
          </span>
        )}
        {glossaryState.kind === "error" && (
          <span style={{ fontSize: 12, color: "var(--danger, #c0392b)" }} title={glossaryState.message}>
            {t("settings.notesSection.failed")}
          </span>
        )}
        <button
          onClick={handleRegenGlossary}
          disabled={glossaryState.kind === "loading"}
          style={{ ...btnStyle, opacity: glossaryState.kind === "loading" ? 0.6 : 1 }}
          title={t("settings.notesSection.regenGlossaryTitle")}
        >
          {glossaryState.kind === "loading" ? t("settings.notesSection.generating") : t("settings.notesSection.regenGlossary")}
        </button>
        <button onClick={handleOpen} style={btnStyle}>
          {t("settings.notesSection.openNote")}
        </button>
      </div>
    </SettingRow>
  );
}

/** Ligne générique « dossier relatif au vault » stockée en config : affichage +
 *  édition inline. `load` fournit la valeur courante (getter dédié ou
 *  `get_config` avec repli). Utilisée pour `recording_folder` et
 *  `new_note_folder` (spec/11). */
function FolderConfigRow({ configKey, defaultValue, load }: {
  configKey: string;
  defaultValue: string;
  load: () => Promise<string>;
}) {
  const t = useT();
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");

  useEffect(() => {
    load().then((v) => setValue(v)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startEdit = () => {
    setEditValue(value);
    setEditing(true);
  };

  const handleSave = async () => {
    const v = editValue.trim().replace(/^\/+|\/+$/g, "") || defaultValue;
    await invoke("set_config", { key: configKey, value: v });
    setValue(v);
    setEditing(false);
  };

  if (editing) {
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          autoFocus
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") setEditing(false);
          }}
          placeholder={defaultValue}
          style={{
            flex: 1, border: "1px solid var(--border)", borderRadius: 6,
            padding: "5px 10px", fontSize: 13,
            background: "var(--card-bg)", color: "var(--text-primary)",
            minWidth: 200,
          }}
        />
        <button
          onClick={handleSave}
          style={{
            background: "var(--accent)", color: "#fff", border: "none",
            borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 13,
          }}
        >
          {t("common.ok")}
        </button>
        <button
          onClick={() => setEditing(false)}
          style={{
            background: "transparent", color: "var(--text-secondary)",
            border: "1px solid var(--border)", borderRadius: 6,
            padding: "5px 12px", cursor: "pointer", fontSize: 13,
          }}
        >
          {t("common.cancel")}
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{ fontSize: 13, color: "var(--text-primary)" }}>{value || defaultValue}</span>
      <button
        onClick={startEdit}
        style={{
          background: "transparent", color: "var(--accent)",
          border: "1px solid var(--border)", borderRadius: 6,
          padding: "4px 10px", cursor: "pointer", fontSize: 12,
        }}
      >
        {t("settings.secret.edit")}
      </button>
    </div>
  );
}

function TodoFileRow() {
  const t = useT();
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");

  useEffect(() => {
    invoke<string>("get_todo_file").then((v) => setValue(v)).catch(() => {});
  }, []);

  const startEdit = () => {
    setEditValue(value);
    setEditing(true);
  };

  const handleSave = async () => {
    const v = editValue.trim() || "wiki/Todo.md";
    await invoke("set_config", { key: "todo_file_path", value: v });
    setValue(v);
    setEditing(false);
  };

  if (editing) {
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          autoFocus
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") setEditing(false);
          }}
          placeholder="wiki/Todo.md"
          style={{
            flex: 1, border: "1px solid var(--border)", borderRadius: 6,
            padding: "5px 10px", fontSize: 13,
            background: "var(--card-bg)", color: "var(--text-primary)",
            minWidth: 200,
          }}
        />
        <button
          onClick={handleSave}
          style={{
            background: "var(--accent)", color: "#fff", border: "none",
            borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 13,
          }}
        >
          {t("common.ok")}
        </button>
        <button
          onClick={() => setEditing(false)}
          style={{
            background: "transparent", color: "var(--text-secondary)",
            border: "1px solid var(--border)", borderRadius: 6,
            padding: "5px 12px", cursor: "pointer", fontSize: 13,
          }}
        >
          {t("common.cancel")}
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{ fontSize: 13, color: "var(--text-primary)" }}>{value || "wiki/Todo.md"}</span>
      <button
        onClick={startEdit}
        style={{
          background: "transparent", color: "var(--accent)",
          border: "1px solid var(--border)", borderRadius: 6,
          padding: "4px 10px", cursor: "pointer", fontSize: 12,
        }}
      >
        {t("settings.secret.edit")}
      </button>
    </div>
  );
}

