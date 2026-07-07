import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MdWarning, MdDownload, MdHourglassEmpty } from "react-icons/md";
import { useNotesStore } from "../store/notesStore";
import type { AccountStatus } from "../bindings/AccountStatus";

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

function SecretInput({
  account,
  label,
  onTest,
}: {
  account: string;
  label: string;
  onTest?: () => Promise<void>;
}) {
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
          Enregistrer
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
          Annuler
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
        {value || "Non défini"}
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
        Modifier
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
          {testing ? "..." : "Tester"}
        </button>
      )}
      {testResult === "ok" && <span style={{ color: "#34C759", fontSize: 12 }}>✓ OK</span>}
      {testResult === "error" && <span style={{ color: "var(--danger)", fontSize: 12 }}>✗ Erreur</span>}
    </div>
  );
}

// ─── AI access section (personal key / AlfredIA subscription) ──────────────────
// Two modes (spec/05, spec/15): "byo" = user's own Anthropic key, "alfredia" =
// our subscription proxy. Subscribing opens Stripe Checkout in the browser; the
// token comes back via loopback (subscribe_alfredia) — zero copy-paste.

function AiAccessSection() {
  const [mode, setMode] = useState<string>("byo");
  const [subStatus, setSubStatus] = useState<"unknown" | "none" | "active" | "error">("unknown");
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const radio = (value: string, label: string) => (
    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, color: "var(--text-primary)", cursor: "pointer" }}>
      <input type="radio" name="ai_mode" checked={mode === value} onChange={() => changeMode(value)} />
      {label}
    </label>
  );

  return (
    <>
      <div style={{ display: "flex", gap: 20, marginBottom: 14 }}>
        {radio("byo", "Ma clé Claude")}
        {radio("alfredia", "Abonnement AlfredIA")}
      </div>

      {mode === "byo" && (
        <SettingRow label="Clé API Claude">
          <SecretInput
            account="claude_api_key"
            label="sk-ant-..."
            onTest={() => invoke("test_api_key", { service: "claude" })}
          />
        </SettingRow>
      )}

      {mode === "alfredia" && (
        <SettingRow label="Abonnement">
          {subStatus === "active" ? (
            <span style={{ fontSize: 13, color: "#34C759" }}>✓ Actif</span>
          ) : (
            <>
              {subStatus === "error" && (
                <span style={{ fontSize: 12, color: "var(--danger)" }}>Abonnement inactif</span>
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
                {subscribing ? "En attente du paiement…" : "S'abonner — 20 €/mois"}
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
                  Annuel
                </button>
              )}
            </>
          )}
        </SettingRow>
      )}
      {error && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 4 }}>{error}</div>}
    </>
  );
}

// ─── Account section (Google sign-in) ──────────────────────────────────────────
// Credentials are shipped with the app, so connecting is a single click — no
// client id/secret to paste. Microsoft is planned for a later phase.

function AccountSection() {
  const [status, setStatus] = useState<AccountStatus>({ connected: false, provider: null, email: null });
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    invoke<AccountStatus>("get_account_status").then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    let unsub: (() => void) | undefined;
    listen("google-oauth-connected", () => { setConnecting(false); refresh(); }).then((fn) => { unsub = fn; });
    return () => unsub?.();
  }, [refresh]);

  const handleConnect = async () => {
    setError(null);
    setConnecting(true);
    try {
      await invoke("start_google_oauth");
    } catch (e) {
      setError(String(e));
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    await invoke("disconnect_account");
    refresh();
  };

  const providerLabel = (p: string | null) =>
    p === "google" ? "Google" : p === "microsoft" ? "Microsoft" : (p ?? "Compte");

  if (status.connected) {
    return (
      <SettingRow label="Compte connecté">
        <span style={{ fontSize: 13, color: "var(--text-primary)" }}>
          {providerLabel(status.provider)}{status.email ? ` · ${status.email}` : ""}
        </span>
        <span style={{ color: "#34C759", fontSize: 13 }}>✓</span>
        <button
          onClick={handleDisconnect}
          style={{
            background: "transparent", color: "var(--danger)",
            border: "1px solid var(--border)", borderRadius: 6,
            padding: "4px 10px", cursor: "pointer", fontSize: 12,
          }}
        >
          Déconnecter
        </button>
      </SettingRow>
    );
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <SettingRow label="Compte">
        <button
          onClick={handleConnect}
          disabled={connecting}
          style={{
            background: connecting ? "var(--border)" : "var(--accent)",
            color: connecting ? "var(--text-secondary)" : "#fff",
            border: "none", borderRadius: 6,
            padding: "6px 14px", cursor: connecting ? "not-allowed" : "pointer",
            fontSize: 13,
          }}
        >
          {connecting ? <><MdHourglassEmpty style={{ verticalAlign: "middle", marginRight: 4 }} /> En attente…</> : "Se connecter avec Google"}
        </button>
      </SettingRow>
      <SettingRow label="Microsoft">
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Bientôt</span>
      </SettingRow>
      {error && (
        <div style={{
          margin: "4px 0 8px", padding: "8px 12px",
          background: "var(--tag-red-bg)", borderRadius: 8,
          fontSize: 12, color: "var(--tag-red-text)",
        }}>
          <MdWarning style={{ verticalAlign: "middle", marginRight: 4 }} /> {error}
        </div>
      )}
    </div>
  );
}

// ─── Settings screen ──────────────────────────────────────────────────────────

export default function Settings() {
  const [whisperModel, setWhisperModel] = useState("small");
  const [languageHint, setLanguageHint] = useState("auto");
  const [recordingSource, setRecordingSource] = useState("mic_only");
  const [syncInterval, setSyncInterval] = useState("15");
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

  useEffect(() => {
    invoke<string | null>("get_config", { key: "whisper_model" }).then((v) => v && setWhisperModel(v));
    invoke<string | null>("get_config", { key: "language_hint" }).then((v) => v && setLanguageHint(v));
    invoke<string | null>("get_config", { key: "recording_source" }).then((v) => v && setRecordingSource(v));
    invoke<string | null>("get_config", { key: "calendar_sync_interval_min" }).then((v) => v && setSyncInterval(v));
    invoke<boolean>("get_launch_at_login").catch(() => false).then((v) => setLaunchAtLogin(v));

    const unsubs: (() => void)[] = [];
    listen<{ percent: number }>("download-progress", (e) => {
      setDownloadProgress(e.payload.percent);
      if (e.payload.percent >= 100) setTimeout(() => setDownloadProgress(null), 2000);
    }).then((fn) => unsubs.push(fn));

    return () => unsubs.forEach((fn) => fn());
  }, []);

  const setConfig = async (key: string, value: string) => {
    await invoke("set_config", { key, value });
  };

  const handleWhisperModelChange = async (model: string) => {
    setWhisperModel(model);
    await setConfig("whisper_model", model);
    try { await invoke("download_model", { size: model }); } catch {}
  };

  const handleLaunchAtLoginChange = async (enabled: boolean) => {
    setLaunchAtLogin(enabled);
    await invoke("set_launch_at_login", { enabled });
  };

  return (
    <div style={{ padding: 32, maxWidth: 600, overflowY: "auto", height: "100%" }}>
      <h1 style={{ margin: "0 0 28px", fontSize: 22, fontWeight: 600, color: "var(--text-primary)" }}>
        Paramètres
      </h1>

      <Section title="Accès IA">
        <AiAccessSection />
      </Section>

      <Section title="APIs">
        <SettingRow label="Clé API Vapi">
          <SecretInput
            account="vapi_api_key"
            label="..."
            onTest={() => invoke("test_api_key", { service: "vapi" })}
          />
        </SettingRow>
        <SettingRow label="ID numéro Vapi">
          <ConfigInput configKey="vapi_phone_number_id" placeholder="phone_num_id_xxx" />
        </SettingRow>
        <SettingRow label="Clé Google Places">
          <SecretInput account="google_places_api_key" label="AIza..." />
        </SettingRow>
      </Section>

      <Section title="Calendrier & compte">
        <AccountSection />
        <SettingRow label="Intervalle de sync">
          <input
            type="number"
            min="5"
            max="60"
            value={syncInterval}
            onChange={(e) => {
              setSyncInterval(e.target.value);
              setConfig("calendar_sync_interval_min", e.target.value);
            }}
            style={{
              width: 60,
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "4px 8px",
              fontSize: 13,
              background: "var(--card-bg)",
              color: "var(--text-primary)",
              textAlign: "center",
            }}
          />
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>minutes</span>
        </SettingRow>
      </Section>

      <Section title="Transcription">
        <SettingRow label="Modèle Whisper">
          <select
            className="alfred-select"
            value={whisperModel}
            onChange={(e) => handleWhisperModelChange(e.target.value)}
          >
            <option value="tiny">Tiny (75 MB, rapide)</option>
            <option value="base">Base (142 MB)</option>
            <option value="small">Small (466 MB, recommandé)</option>
            <option value="medium">Medium (1.5 GB, précis)</option>
          </select>
          {downloadProgress !== null && (
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              <MdDownload style={{ verticalAlign: "middle", marginRight: 2 }} /> {Math.round(downloadProgress)}%
            </span>
          )}
        </SettingRow>
        <SettingRow label="Langue">
          <select
            className="alfred-select"
            value={languageHint}
            onChange={(e) => {
              setLanguageHint(e.target.value);
              setConfig("language_hint", e.target.value);
            }}
          >
            <option value="auto">Auto-détection</option>
            <option value="fr">Français</option>
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="de">Deutsch</option>
          </select>
        </SettingRow>
      </Section>

      <Section title="Enregistrement">
        <SettingRow label="Source audio">
          <select
            className="alfred-select"
            value={recordingSource}
            onChange={(e) => {
              setRecordingSource(e.target.value);
              setConfig("recording_source", e.target.value);
            }}
          >
            <option value="mic_only">Microphone uniquement</option>
            <option value="system_only">Audio système uniquement</option>
            <option value="mixed">Mixte (micro + système)</option>
          </select>
        </SettingRow>
        <SettingRow label="Dossier des enregistrements">
          <RecordingFolderRow />
        </SettingRow>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          Chemin relatif au vault où l'audio et la transcription sont déposés. Ex. <code>raw/audios</code>
        </div>
      </Section>

      <Section title="Notes">
        <VaultPathRow />
      </Section>

      <Section title="Tâches">
        <SettingRow label="Fichier de la to-do list">
          <TodoFileRow />
        </SettingRow>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          Chemin relatif au dossier Notes (vault). Ex. <code>wiki/Todo.md</code>
        </div>
      </Section>

      <Section title="Ingestion">
        <IngestPromptEditor />
      </Section>

      <Section title="Système">
        <SettingRow label="Lancer au démarrage">
          <input
            type="checkbox"
            checked={launchAtLogin}
            onChange={(e) => handleLaunchAtLoginChange(e.target.checked)}
            style={{ cursor: "pointer" }}
          />
        </SettingRow>
        <SettingRow label="Introduction">
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
            Revoir l'introduction
          </button>
        </SettingRow>
      </Section>
    </div>
  );
}

function VaultPathRow() {
  const { vaultPath, fetchVaultPath, setVaultPath, pickVaultFolder } = useNotesStore();

  useEffect(() => { fetchVaultPath(); }, [fetchVaultPath]);

  const handlePick = async () => {
    const picked = await pickVaultFolder();
    if (picked) await setVaultPath(picked);
  };

  const displayPath = vaultPath
    ? (vaultPath.length > 40 ? "…" + vaultPath.slice(-40) : vaultPath)
    : "Non configuré";

  return (
    <SettingRow label="Dossier Notes (vault)">
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
        Choisir…
      </button>
    </SettingRow>
  );
}

function IngestPromptEditor() {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    invoke<string>("get_ingest_prompt")
      .then((p) => setPrompt(p))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    await invoke("set_config", { key: "ingest_prompt", value: prompt });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 8 }}>
        Prompt exécuté par Claude (CLI local) lors de l'ingestion lancée depuis l'onglet Notes.
        Il s'exécute dans le dossier du vault, en suivant son <code>CLAUDE.md</code>.
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={loading}
        rows={5}
        placeholder={loading ? "Chargement…" : "Prompt d'ingestion…"}
        style={{
          width: "100%", resize: "vertical", boxSizing: "border-box",
          fontFamily: "inherit", fontSize: 13, lineHeight: 1.5,
          color: "var(--text-primary)", background: "var(--card-bg)",
          border: "1px solid var(--border)", borderRadius: 8,
          padding: "10px 12px", outline: "none",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
        <button
          onClick={handleSave}
          disabled={loading}
          style={{
            background: "var(--accent)", color: "#fff", border: "none",
            borderRadius: 6, padding: "6px 16px", cursor: loading ? "not-allowed" : "pointer",
            fontSize: 13,
          }}
        >
          Enregistrer
        </button>
        {saved && <span style={{ color: "#34C759", fontSize: 12 }}>✓ Enregistré</span>}
      </div>
    </div>
  );
}

function RecordingFolderRow() {
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");

  useEffect(() => {
    invoke<string>("get_recording_folder").then((v) => setValue(v)).catch(() => {});
  }, []);

  const startEdit = () => {
    setEditValue(value);
    setEditing(true);
  };

  const handleSave = async () => {
    const v = editValue.trim().replace(/^\/+|\/+$/g, "") || "raw/audios";
    await invoke("set_config", { key: "recording_folder", value: v });
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
          placeholder="raw/audios"
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
          OK
        </button>
        <button
          onClick={() => setEditing(false)}
          style={{
            background: "transparent", color: "var(--text-secondary)",
            border: "1px solid var(--border)", borderRadius: 6,
            padding: "5px 12px", cursor: "pointer", fontSize: 13,
          }}
        >
          Annuler
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{ fontSize: 13, color: "var(--text-primary)" }}>{value || "raw/audios"}</span>
      <button
        onClick={startEdit}
        style={{
          background: "transparent", color: "var(--accent)",
          border: "1px solid var(--border)", borderRadius: 6,
          padding: "4px 10px", cursor: "pointer", fontSize: 12,
        }}
      >
        Modifier
      </button>
    </div>
  );
}

function TodoFileRow() {
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
          OK
        </button>
        <button
          onClick={() => setEditing(false)}
          style={{
            background: "transparent", color: "var(--text-secondary)",
            border: "1px solid var(--border)", borderRadius: 6,
            padding: "5px 12px", cursor: "pointer", fontSize: 13,
          }}
        >
          Annuler
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
        Modifier
      </button>
    </div>
  );
}

function ConfigInput({ configKey, placeholder }: { configKey: string; placeholder: string }) {
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    invoke<string | null>("get_config", { key: configKey }).then((v) => v && setValue(v));
  }, [configKey]);

  const handleSave = async () => {
    await invoke("set_config", { key: configKey, value });
    setEditing(false);
  };

  if (editing) {
    return (
      <div style={{ display: "flex", gap: 8 }}>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
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
          OK
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{ fontSize: 13, color: value ? "var(--text-primary)" : "var(--text-secondary)" }}>
        {value || "Non défini"}
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
        Modifier
      </button>
    </div>
  );
}
