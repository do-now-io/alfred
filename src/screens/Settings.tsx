import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MdDownload } from "react-icons/md";
import { useNotesStore } from "../store/notesStore";
import { useTourStore } from "../store/tourStore";
import { useProfileStore } from "../store/profileStore";
import type { NoteFile } from "../bindings/NoteFile";

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
        title="Changer l'avatar"
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
          placeholder="Votre prénom"
          style={{
            width: "100%", border: "1px solid var(--border)", borderRadius: 8,
            padding: "8px 11px", fontSize: 14, background: "var(--bg)", color: "var(--text-primary)",
            boxSizing: "border-box",
          }}
        />
        <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 5 }}>
          Je m'en sers pour « Assigner à moi » (Tâches) et pour vous reconnaître parmi les participants.
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

// ─── Settings screen ──────────────────────────────────────────────────────────

export default function Settings() {
  const navigate = useNavigate();
  const [whisperModel, setWhisperModel] = useState("small");
  const [languageHint, setLanguageHint] = useState("auto");
  const [recordingSource, setRecordingSource] = useState("mixed");
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

  useEffect(() => {
    invoke<string | null>("get_config", { key: "whisper_model" }).then((v) => v && setWhisperModel(v));
    invoke<string | null>("get_config", { key: "language_hint" }).then((v) => v && setLanguageHint(v));
    invoke<string | null>("get_config", { key: "recording_source" }).then((v) => v && setRecordingSource(v));
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

      <Section title="Profil">
        <ProfileSection />
      </Section>

      <Section title="Accès IA">
        <AiAccessSection />
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
          Chemin relatif au vault où l'audio et la transcription sont déposés. Ex. <code>alfred-raw</code>
        </div>
      </Section>

      <Section title="Notes">
        <VaultPathRow />
        <ContextNoteRow />
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          Décrivez votre entreprise, votre équipe et votre vocabulaire maison : je m'en
          sers pour corriger les noms propres dans les transcriptions et comptes-rendus.
        </div>
      </Section>

      <Section title="Tâches">
        <SettingRow label="Fichier de la to-do list">
          <TodoFileRow />
        </SettingRow>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          Chemin relatif au dossier Notes (vault). Ex. <code>alfred-intelligence/Todo.md</code>
        </div>
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
        <SettingRow label="Visite guidée">
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
            Revoir la visite guidée
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

function ContextNoteRow() {
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
    <SettingRow label="Contexte interne">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
        {glossaryState.kind === "done" && (
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {glossaryState.terms > 0 ? `Glossaire : ~${glossaryState.terms} termes` : "Contexte vide"}
          </span>
        )}
        {glossaryState.kind === "error" && (
          <span style={{ fontSize: 12, color: "var(--danger, #c0392b)" }} title={glossaryState.message}>
            Échec
          </span>
        )}
        <button
          onClick={handleRegenGlossary}
          disabled={glossaryState.kind === "loading"}
          style={{ ...btnStyle, opacity: glossaryState.kind === "loading" ? 0.6 : 1 }}
          title="Régénère le glossaire de transcription (noms propres) à partir de la note de contexte"
        >
          {glossaryState.kind === "loading" ? "Génération…" : "Régénérer le glossaire"}
        </button>
        <button onClick={handleOpen} style={btnStyle}>
          Ouvrir la note
        </button>
      </div>
    </SettingRow>
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
    const v = editValue.trim().replace(/^\/+|\/+$/g, "") || "alfred-raw";
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
          placeholder="alfred-raw"
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
      <span style={{ fontSize: 13, color: "var(--text-primary)" }}>{value || "alfred-raw"}</span>
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

