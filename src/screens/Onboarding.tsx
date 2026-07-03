import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  MdMic, MdAutoAwesome, MdStickyNote2, MdEventNote, MdChatBubbleOutline,
  MdCheckCircle, MdFolderOpen, MdVpnKey, MdGraphicEq, MdArrowBack, MdArrowForward,
  MdHourglassEmpty, MdWarning,
} from "react-icons/md";
import { useNotesStore } from "../store/notesStore";
import alfredLogo from "../assets/alfred-logo.png";
import type { AccountStatus } from "../bindings/AccountStatus";

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

// ─── Setup steps ──────────────────────────────────────────────────────────────

function ConnectAccountStep() {
  const [status, setStatus] = useState<AccountStatus>({ connected: false, provider: null, email: null });
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => invoke<AccountStatus>("get_account_status").then(setStatus).catch(() => {});

  useEffect(() => {
    refresh();
    let unsub: (() => void) | undefined;
    listen("google-oauth-connected", () => { setConnecting(false); refresh(); }).then((fn) => { unsub = fn; });
    return () => unsub?.();
  }, []);

  const connect = async () => {
    setError(null);
    setConnecting(true);
    try {
      await invoke("start_google_oauth");
    } catch (e) {
      setError(String(e));
      setConnecting(false);
    }
  };

  if (status.connected) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, color: "#34C759", fontSize: 15 }}>
        <MdCheckCircle size={20} />
        <span style={{ color: "var(--text-primary)" }}>
          Connecté{status.email ? ` · ${status.email}` : ""}
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      <button onClick={connect} disabled={connecting} style={primaryBtn(connecting)}>
        {connecting
          ? <><MdHourglassEmpty size={18} /> En attente du navigateur…</>
          : <>Se connecter avec Google</>}
      </button>
      <button disabled style={{ ...primaryBtn(true), background: "transparent", border: "1px solid var(--border)" }}>
        Se connecter avec Microsoft — bientôt
      </button>
      {error && (
        <div style={{ color: "var(--danger)", fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
          <MdWarning size={15} /> {error}
        </div>
      )}
    </div>
  );
}

function VaultStep() {
  const { vaultPath, fetchVaultPath, setVaultPath, pickVaultFolder } = useNotesStore();

  useEffect(() => { fetchVaultPath(); }, [fetchVaultPath]);

  const pick = async () => {
    const picked = await pickVaultFolder();
    if (picked) await setVaultPath(picked);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      <button onClick={pick} style={primaryBtn()}>
        <MdFolderOpen size={18} /> Choisir un dossier
      </button>
      {vaultPath && (
        <div style={{ fontSize: 13, color: "#34C759", display: "flex", alignItems: "center", gap: 6 }}>
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
          placeholder={hasKey ? "•••••••••• (déjà définie — remplacer)" : "sk-ant-..."}
          style={{
            flex: 1, border: "1px solid var(--border)", borderRadius: 8,
            padding: "9px 12px", fontSize: 14, background: "var(--card-bg)", color: "var(--text-primary)",
          }}
        />
        <button onClick={save} disabled={!value.trim() || state === "saving"} style={primaryBtn(!value.trim() || state === "saving")}>
          {state === "saving" ? <MdHourglassEmpty size={18} /> : <MdVpnKey size={18} />} Valider
        </button>
      </div>
      {(state === "ok" || (hasKey && state === "idle")) && (
        <div style={{ fontSize: 13, color: "#34C759", display: "flex", alignItems: "center", gap: 6 }}>
          <MdCheckCircle size={16} /> Clé enregistrée{state === "ok" ? " et validée" : ""}
        </div>
      )}
      {state === "error" && (
        <div style={{ fontSize: 13, color: "var(--danger)", display: "flex", alignItems: "center", gap: 6 }}>
          <MdWarning size={15} /> Clé invalide ou erreur réseau
        </div>
      )}
    </div>
  );
}

const SELECT_STYLE: React.CSSProperties = {
  border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px",
  fontSize: 14, background: "var(--card-bg)", color: "var(--text-primary)", width: "100%",
};

function WhisperStep() {
  const [model, setModel] = useState("small");
  const [lang, setLang] = useState("auto");
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    invoke<string | null>("get_config", { key: "whisper_model" }).then((v) => v && setModel(v));
    invoke<string | null>("get_config", { key: "language_hint" }).then((v) => v && setLang(v));
    let unsub: (() => void) | undefined;
    listen<{ percent: number }>("download-progress", (e) => {
      setProgress(e.payload.percent);
      if (e.payload.percent >= 100) setTimeout(() => setProgress(null), 2000);
    }).then((fn) => { unsub = fn; });
    return () => unsub?.();
  }, []);

  const changeModel = async (m: string) => {
    setModel(m);
    await invoke("set_config", { key: "whisper_model", value: m });
    try { await invoke("download_model", { size: m }); } catch {}
  };

  const changeLang = async (l: string) => {
    setLang(l);
    await invoke("set_config", { key: "language_hint", value: l });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, textAlign: "left" }}>
      <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>
        Modèle de transcription
        <select className="alfred-select" value={model} onChange={(e) => changeModel(e.target.value)} style={{ ...SELECT_STYLE, marginTop: 4 }}>
          <option value="tiny">Tiny (75 MB, rapide)</option>
          <option value="base">Base (142 MB)</option>
          <option value="small">Small (466 MB, recommandé)</option>
          <option value="medium">Medium (1.5 GB, précis)</option>
        </select>
      </label>
      {progress !== null && (
        <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Téléchargement… {Math.round(progress)}%</div>
      )}
      <label style={{ fontSize: 13, color: "var(--text-secondary)" }}>
        Langue
        <select className="alfred-select" value={lang} onChange={(e) => changeLang(e.target.value)} style={{ ...SELECT_STYLE, marginTop: 4 }}>
          <option value="auto">Auto-détection</option>
          <option value="fr">Français</option>
          <option value="en">English</option>
          <option value="es">Español</option>
          <option value="de">Deutsch</option>
        </select>
      </label>
    </div>
  );
}

function MicStep() {
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
        {state === "testing" ? <><MdHourglassEmpty size={18} /> Test en cours…</> : <><MdMic size={18} /> Tester le micro</>}
      </button>
      {state === "ok" && (
        <div style={{ fontSize: 13, color: "#34C759", display: "flex", alignItems: "center", gap: 6 }}>
          <MdCheckCircle size={16} /> Micro accessible
        </div>
      )}
      {state === "error" && (
        <div style={{ fontSize: 13, color: "var(--danger)", display: "flex", alignItems: "center", gap: 6 }}>
          <MdWarning size={15} /> Accès refusé — autorisez Alfred dans Réglages Système → Confidentialité → Micro
        </div>
      )}
    </div>
  );
}

// ─── Wizard ─────────────────────────────────────────────────────────────────

type Step = { node: React.ReactNode; skippable?: boolean };

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [finishing, setFinishing] = useState(false);

  const steps: Step[] = [
    {
      node: (
        <Panel
          icon={<img src={alfredLogo} alt="Alfred" style={{ width: 84, height: "auto", borderRadius: 18 }} />}
          title="Bienvenue dans Alfred"
          text="Votre assistant personnel : il capture vos pensées à la voix, les transforme en notes et en tâches, et garde un œil sur votre agenda. Voici comment tout s'articule."
        />
      ),
    },
    {
      node: (
        <Panel
          icon={<IconCircle><MdMic /></IconCircle>}
          title="Capturez à la voix"
          text="Lancez un enregistrement et parlez naturellement. Alfred transcrit en local (Whisper). L'enregistrement continue même si vous changez de vue — il tourne en arrière-plan."
        />
      ),
    },
    {
      node: (
        <Panel
          icon={<IconCircle><MdAutoAwesome /></IconCircle>}
          title="Des tâches extraites automatiquement"
          text="À partir de vos transcriptions, Alfred détecte les actions à faire et les ajoute à votre to-do. Les tâches prioritaires (★) remontent sur le tableau de bord."
        />
      ),
    },
    {
      node: (
        <Panel
          icon={<IconCircle><MdStickyNote2 /></IconCircle>}
          title="Vos notes, reliées entre elles"
          text="Un coffre de notes en markdown avec liens [[wiki]] et tags. Le Graphe visualise les connexions entre vos notes pour naviguer dans votre savoir."
        />
      ),
    },
    {
      node: (
        <Panel
          icon={<IconCircle><MdEventNote /></IconCircle>}
          title="Votre agenda, augmenté"
          text="Alfred synchronise le calendrier de votre compte connecté, prépare des résumés avant vos réunions, et peut même appeler un restaurant pour réserver à votre place."
        />
      ),
    },
    {
      node: (
        <Panel
          icon={<IconCircle><MdChatBubbleOutline /></IconCircle>}
          title="Discutez avec Alfred"
          text="Posez des questions sur vos notes, demandez un résumé de votre semaine. Tout est connecté : enregistrements, notes, tâches et agenda nourrissent les réponses."
        />
      ),
    },
    {
      skippable: true,
      node: (
        <Panel
          icon={<IconCircle tone="dark"><MdEventNote /></IconCircle>}
          title="Connectez votre compte"
          text="Connectez Google pour donner à Alfred l'accès à votre calendrier et à vos emails. Vous pourrez le faire plus tard depuis les Réglages."
        >
          <ConnectAccountStep />
        </Panel>
      ),
    },
    {
      skippable: true,
      node: (
        <Panel
          icon={<IconCircle><MdFolderOpen /></IconCircle>}
          title="Choisissez votre dossier de notes"
          text="Alfred range vos notes dans un dossier markdown (le « vault »). Choisissez-en un — un dossier existant ou un nouveau."
        >
          <VaultStep />
        </Panel>
      ),
    },
    {
      skippable: true,
      node: (
        <Panel
          icon={<IconCircle><MdVpnKey /></IconCircle>}
          title="Clé API Claude"
          text="L'IA d'Alfred (extraction de tâches, chat, résumés) tourne avec Claude. Collez votre clé API pour l'activer."
        >
          <ClaudeKeyStep />
        </Panel>
      ),
    },
    {
      skippable: true,
      node: (
        <Panel
          icon={<IconCircle><MdGraphicEq /></IconCircle>}
          title="Transcription"
          text="Choisissez le modèle Whisper et la langue. Small est un bon compromis ; un plus gros modèle est plus précis mais plus lourd."
        >
          <WhisperStep />
        </Panel>
      ),
    },
    {
      skippable: true,
      node: (
        <Panel
          icon={<IconCircle tone="dark"><MdMic /></IconCircle>}
          title="Autorisez le micro"
          text="Faites un test rapide pour vérifier l'accès au microphone (macOS vous demandera l'autorisation)."
        >
          <MicStep />
        </Panel>
      ),
    },
    {
      node: (
        <Panel
          icon={<IconCircle><MdCheckCircle /></IconCircle>}
          title="Tout est prêt !"
          text="Vous pouvez commencer. Vous retrouverez tous ces réglages à tout moment dans Paramètres."
        />
      ),
    },
  ];

  const total = steps.length;
  const isLast = step === total - 1;
  const current = steps[step];

  const finish = async () => {
    setFinishing(true);
    try { await invoke("set_config", { key: "onboarding_completed", value: "true" }); }
    catch { /* non-fatal */ }
    onDone();
  };

  const next = () => (isLast ? finish() : setStep((s) => Math.min(s + 1, total - 1)));
  const back = () => setStep((s) => Math.max(s - 1, 0));

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
            <MdArrowBack size={16} /> Précédent
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {current.skippable && !isLast && (
              <button
                onClick={next}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 14 }}
              >
                Passer
              </button>
            )}
            <button onClick={next} disabled={finishing} style={primaryBtn(finishing)}>
              {isLast ? "Commencer" : <>Suivant <MdArrowForward size={16} /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
