import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  MdMic, MdAutoAwesome, MdCheckCircle, MdFolderOpen, MdVpnKey,
  MdArrowBack, MdArrowForward, MdHourglassEmpty, MdWarning,
} from "react-icons/md";
import { useNotesStore } from "../store/notesStore";
import alfredLogo from "../assets/alfred-logo.png";

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
        <div style={okRow}><MdCheckCircle size={16} /> Clé enregistrée{state === "ok" ? " et validée" : ""}</div>
      )}
      {state === "error" && (
        <div style={errorRow}><MdWarning size={15} /> Clé invalide ou erreur réseau</div>
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
  const [mode, setMode] = useState<"byo" | "alfredia">("byo");
  const [subState, setSubState] = useState<"idle" | "subscribing" | "active" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const refreshSub = () => {
    invoke<string | null>("get_secret", { account: "alfredia_token" }).then((t) => {
      if (!t) return;
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
        <button onClick={() => changeMode("byo")} style={modeBtn(mode === "byo")}>Ma clé Claude</button>
        <button onClick={() => changeMode("alfredia")} style={modeBtn(mode === "alfredia")}>Abonnement AlfredIA</button>
      </div>

      {mode === "byo" ? (
        <ClaudeKeyStep />
      ) : subState === "active" ? (
        <div style={{ ...okRow, justifyContent: "center" }}><MdCheckCircle size={16} /> Abonnement actif</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <button onClick={() => subscribe("monthly")} disabled={subState === "subscribing"} style={primaryBtn(subState === "subscribing")}>
            {subState === "subscribing" ? <><MdHourglassEmpty size={18} /> En attente du paiement…</> : "S'abonner — 20 €/mois"}
          </button>
          {subState !== "subscribing" && (
            <button onClick={() => subscribe("yearly")} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 8, padding: "7px 16px", cursor: "pointer", fontSize: 13, color: ACCENT }}>
              Annuel
            </button>
          )}
          {error && <div style={errorRow}><MdWarning size={15} /> {error}</div>}
        </div>
      )}
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
      {state === "ok" && <div style={okRow}><MdCheckCircle size={16} /> Micro accessible</div>}
      {state === "error" && (
        <div style={errorRow}><MdWarning size={15} /> Accès refusé — autorisez Alfred dans les réglages système</div>
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
          text="Votre majordome personnel : il écoute, transcrit, résume et retient — pour que vous n'ayez plus à prendre de notes vous-même. Deux minutes d'installation, puis on essaie ensemble."
        />
      ),
    },
    {
      node: (
        <Panel
          icon={<IconCircle><MdMic /></IconCircle>}
          title="Parlez, il transcrit"
          text="Lancez un enregistrement et parlez naturellement — réunion, note vocale, brainstorm. La transcription tourne en local (Whisper, déjà installé, ça marche hors ligne dès le premier lancement) et continue même si vous changez de vue."
        />
      ),
    },
    {
      node: (
        <Panel
          icon={<IconCircle><MdAutoAwesome /></IconCircle>}
          title="Il en tire l'essentiel"
          text="De chaque enregistrement, Alfred rédige un compte-rendu et en extrait les tâches à faire — avec le responsable, quand vous le nommez. Vos notes restent reliées entre elles, et vous pouvez lui parler directement pour retrouver n'importe quoi."
        />
      ),
    },
    {
      skippable: true,
      node: (
        <Panel
          icon={<IconCircle><MdFolderOpen /></IconCircle>}
          title="Choisissez votre dossier de notes"
          text="Alfred range tout dans un dossier markdown (le « vault »), compatible Obsidian. Choisissez-en un — un dossier existant ou un nouveau, rien d'autre n'y sera touché."
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
          title="Accès à l'IA"
          text="Alfred s'appuie sur Claude pour rédiger, extraire les tâches et répondre à vos questions. Choisissez comment y accéder — modifiable à tout moment dans les Réglages."
        >
          <AiAccessStep />
        </Panel>
      ),
    },
    {
      skippable: true,
      node: (
        <Panel
          icon={<IconCircle tone="dark"><MdMic /></IconCircle>}
          title="Autorisez le micro"
          text="Un test rapide pour vérifier l'accès au microphone (macOS vous demandera l'autorisation la première fois)."
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
          text="Vous retrouverez tous ces réglages à tout moment dans Paramètres. Une dernière chose avant de vous lâcher dans l'app…"
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
    // Contenu de démarrage (spec/13) : tâches checklist, notes de démo,
    // conversation d'exemple — pour que la visite (et l'arrivée hors visite) ait
    // de la matière. Idempotent côté backend (flag `starter_content_seeded`).
    try { await invoke("seed_starter_content"); }
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
