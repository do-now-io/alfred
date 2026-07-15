import { useEffect, useState } from "react";
import { MdShare, MdContentCopy, MdLinkOff, MdCheck } from "react-icons/md";

// Note sharing (spec/18): publish a Markdown note to a public-by-link URL. Generic
// over the three backend calls so both a vault note and Todo.md can reuse it.

interface Props {
  /** Current public URL if already shared, else null. */
  getLink: () => Promise<string | null>;
  /** Create/update the share, returns the URL. */
  share: () => Promise<string>;
  /** Revoke the share. */
  unshare: () => Promise<void>;
  /** Changing this resets local state (e.g. the selected note path). */
  resetKey?: string;
}

// One-time consent: sharing sends content off-device (spec/18).
const CONSENT_KEY = "alfred_share_consent";

export default function ShareButton({ getLink, share, unshare, resetKey }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setCopied(false);
    getLink().then((u) => { if (!cancelled) setUrl(u); }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const copy = async (u: string) => {
    try {
      await navigator.clipboard.writeText(u);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — the URL is still shown on hover/title */
    }
  };

  const doShare = async () => {
    if (busy) return;
    if (!localStorage.getItem(CONSENT_KEY)) {
      const ok = window.confirm(
        "Partager ?\n\nLe contenu sera envoyé sur les serveurs Alfred et accessible par toute personne disposant du lien. Tu pourras arrêter le partage à tout moment.",
      );
      if (!ok) return;
      localStorage.setItem(CONSENT_KEY, "1");
    }
    setBusy(true);
    try {
      const u = await share();
      setUrl(u);
      await copy(u);
    } catch (e) {
      window.alert(`Partage impossible : ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const doUnshare = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await unshare();
      setUrl(null);
    } catch (e) {
      window.alert(`Impossible d'arrêter le partage : ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const btn: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 6,
    background: "transparent", color: "var(--accent)",
    border: "1px solid var(--border)", borderRadius: 8,
    padding: "5px 12px", cursor: busy ? "default" : "pointer",
    fontSize: 12.5, opacity: busy ? 0.6 : 1,
  };

  if (url) {
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button onClick={() => copy(url)} style={btn} title={url}>
          {copied ? <><MdCheck size={15} /> Copié</> : <><MdContentCopy size={15} /> Copier le lien</>}
        </button>
        <button onClick={doUnshare} disabled={busy} style={btn} title="Arrêter le partage">
          <MdLinkOff size={15} /> Ne plus partager
        </button>
      </div>
    );
  }
  return (
    <button onClick={doShare} disabled={busy} style={btn} title="Publier un lien de partage">
      <MdShare size={15} /> {busy ? "Partage…" : "Partager"}
    </button>
  );
}
