import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useChatStore, type ChatTurn } from "../../store/chatStore";
import { useNotesStore } from "../../store/notesStore";
import BriefingContent from "../BriefingContent";
import type { ChatSource } from "../../bindings/ChatSource";

const SUGGESTIONS = [
  "Résume mes notes récentes",
  "Sur quoi ai-je travaillé cette semaine ?",
];

const COLUMN_MAX = 760;

export default function ChatPanel() {
  const { messages, loading, progress, error, send, clear } = useChatStore();
  const [input, setInput] = useState("");
  const navigate = useNavigate();
  const selectFile = useNotesStore(s => s.selectFile);
  const openNoteByRef = useNotesStore(s => s.openNoteByRef);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the latest message / progress in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, progress, loading]);

  const openByPath = async (path: string) => {
    await selectFile(path);
    navigate("/notes");
  };

  const handleWikilink = async (ref: string) => {
    const ok = await openNoteByRef(ref);
    if (ok) navigate("/notes");
  };

  const submit = (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || loading) return;
    setInput("");
    send(q);
  };

  const isEmpty = messages.length === 0 && !loading;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header */}
      <div style={{
        flexShrink: 0, padding: "16px 24px",
        borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <span style={{ color: "var(--accent)", fontSize: 18 }}>✦</span>
        <h1 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--text-primary)" }}>
          Demander à Alfred
        </h1>
        {messages.length > 0 && (
          <button
            onClick={clear}
            disabled={loading}
            style={{
              marginLeft: "auto", background: "none", border: "1px solid var(--border)",
              borderRadius: 6, padding: "4px 12px", cursor: loading ? "not-allowed" : "pointer",
              fontSize: 12, color: "var(--text-secondary)",
            }}
          >
            ↻ Nouvelle conversation
          </button>
        )}
      </div>

      {/* Conversation */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "24px" }}>
        <div style={{ maxWidth: COLUMN_MAX, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
          {isEmpty ? (
            <EmptyState onPick={submit} />
          ) : (
            <>
              {messages.map(m =>
                m.role === "user"
                  ? <UserBubble key={m.id} text={m.content} />
                  : <AssistantBubble key={m.id} turn={m} onWikilink={handleWikilink} onOpenSource={openByPath} />
              )}
              {loading && <ProgressView progress={progress} />}
              {error && <div style={{ fontSize: 13, color: "var(--danger)" }}>⚠ {error}</div>}
            </>
          )}
        </div>
      </div>

      {/* Input */}
      <div style={{ flexShrink: 0, borderTop: "1px solid var(--border)", padding: "16px 24px" }}>
        <div style={{ maxWidth: COLUMN_MAX, margin: "0 auto", display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
            placeholder="Poser une question…"
            rows={2}
            disabled={loading}
            style={{
              flex: 1, resize: "none", fontFamily: "inherit", fontSize: 13.5,
              color: "var(--text-primary)", background: "var(--bg)",
              border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px",
              lineHeight: 1.5, outline: "none",
            }}
          />
          <button
            onClick={() => submit()}
            disabled={loading || !input.trim()}
            style={{
              background: loading || !input.trim() ? "var(--border)" : "var(--accent)",
              color: "#fff", border: "none", borderRadius: 8,
              padding: "11px 18px", cursor: loading || !input.trim() ? "not-allowed" : "pointer",
              fontSize: 13, fontWeight: 500, whiteSpace: "nowrap",
            }}
          >
            {loading ? "⏳" : "Envoyer"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div style={{
      paddingTop: 56, display: "flex", flexDirection: "column",
      alignItems: "center", gap: 14, textAlign: "center",
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: "50%",
        background: "var(--dark-card)", border: "2px solid var(--accent)",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "var(--accent)", fontSize: 24,
      }}>
        ✦
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
        Demander à Alfred
      </div>
      <div style={{ fontSize: 13.5, color: "var(--text-muted)", maxWidth: 460, lineHeight: 1.6 }}>
        Posez une question sur vos notes — Alfred cherche dans votre coffre et répond en citant ses sources.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 4 }}>
        {SUGGESTIONS.map(s => (
          <button
            key={s}
            onClick={() => onPick(s)}
            style={{
              background: "var(--active-bg)", border: "1px solid var(--border)",
              borderRadius: 16, padding: "6px 14px", cursor: "pointer",
              fontSize: 12.5, color: "var(--text-secondary)",
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Message bubbles ──────────────────────────────────────────────────────────

function UserBubble({ text }: { text: string }) {
  return (
    <div style={{ alignSelf: "flex-end", maxWidth: "85%" }}>
      <div style={{
        background: "var(--active-bg)", border: "1px solid var(--border)",
        borderRadius: "12px 12px 2px 12px", padding: "9px 14px",
        fontSize: 13.5, color: "var(--text-primary)", lineHeight: 1.5,
        whiteSpace: "pre-wrap",
      }}>
        {text}
      </div>
    </div>
  );
}

function AssistantBubble({
  turn, onWikilink, onOpenSource,
}: {
  turn: ChatTurn;
  onWikilink: (ref: string) => void;
  onOpenSource: (path: string) => void;
}) {
  return (
    <div style={{ alignSelf: "flex-start", maxWidth: "100%", width: "100%" }}>
      <BriefingContent markdown={turn.content} onWikilink={onWikilink} />
      {turn.sources && turn.sources.length > 0 && (
        <SourceChips sources={turn.sources} onOpen={onOpenSource} />
      )}
    </div>
  );
}

function SourceChips({ sources, onOpen }: { sources: ChatSource[]; onOpen: (path: string) => void }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>
        Sources
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {sources.map(s => (
          <button
            key={s.path}
            onClick={() => onOpen(s.path)}
            title={s.title}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              background: "var(--card-bg)", border: "1px solid var(--accent)",
              borderRadius: 16, padding: "4px 12px", cursor: "pointer",
              fontSize: 12, fontWeight: 500, color: "var(--accent)", maxWidth: 240,
            }}
          >
            <span>▣</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {s.title}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ProgressView({ progress }: { progress: string[] }) {
  return (
    <div style={{ alignSelf: "flex-start", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.8 }}>
      {progress.length === 0 ? (
        <div>⏳ Alfred réfléchit…</div>
      ) : (
        progress.map((line, i) => <div key={i}>{line}</div>)
      )}
    </div>
  );
}
