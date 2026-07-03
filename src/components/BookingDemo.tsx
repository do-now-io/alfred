import { useEffect, useState } from "react";
import { MdPhone, MdCheckCircle, MdCall } from "react-icons/md";
import type { CalendarEvent } from "../bindings/CalendarEvent";

interface Props {
  event: CalendarEvent;
  onClose: () => void;
}

type Phase = "form" | "connecting" | "call" | "done";

interface Line {
  speaker: "alfred" | "restaurant";
  text: string;
  delayBefore: number; // ms of "typing" pause before the line starts
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 14,
  background: "var(--card-bg)",
  color: "var(--text-primary)",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-secondary)",
  display: "block",
  marginBottom: 4,
};

function TypingDots() {
  return (
    <span style={{ fontSize: 10, letterSpacing: 2, color: "var(--text-muted)" }}>
      <style>{`
        .alfred-dot { animation: alfredBlink 1.2s infinite; }
        .alfred-dot:nth-child(2) { animation-delay: 0.2s; }
        .alfred-dot:nth-child(3) { animation-delay: 0.4s; }
        @keyframes alfredBlink { 0%, 80%, 100% { opacity: 0.15; } 40% { opacity: 1; } }
      `}</style>
      <span className="alfred-dot">●</span>
      <span className="alfred-dot">●</span>
      <span className="alfred-dot">●</span>
    </span>
  );
}

function formatDateLabel(dateStr: string): string {
  try {
    return new Date(dateStr + "T00:00:00").toLocaleDateString("fr-FR", {
      day: "numeric", month: "long", year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function buildScript(partySize: string, time: string, dateLabel: string): Line[] {
  return [
    {
      speaker: "alfred",
      delayBefore: 1200,
      text: `Bonjour, je suis Alfred, l'assistant de Tanguy. Je vous appelle pour réserver une table pour ${partySize} personnes à ${time} le ${dateLabel}.`,
    },
    // longer silence — the restaurant takes a moment to answer
    {
      speaker: "restaurant",
      delayBefore: 2400,
      text: `Oui, j'ai de la place. Pour ${partySize}, je réserve à quel nom ?`,
    },
    { speaker: "alfred", delayBefore: 900, text: "Tanguy." },
    {
      speaker: "restaurant",
      delayBefore: 1200,
      text: "Parfait. Souhaitez-vous être en terrasse ?",
    },
    { speaker: "alfred", delayBefore: 900, text: "Oui, en terrasse s'il fait beau, volontiers." },
    {
      speaker: "restaurant",
      delayBefore: 1100,
      text: `Très bien, c'est enregistré pour ${time}. Excellente journée à vous.`,
    },
    { speaker: "alfred", delayBefore: 800, text: "Excellente journée à vous." },
  ];
}

export default function BookingDemo({ event, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("form");

  const [restaurantName, setRestaurantName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [partySize, setPartySize] = useState("2");
  const [time, setTime] = useState(() => {
    try {
      return new Date(event.start_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "20:00";
    }
  });
  const [date, setDate] = useState(event.start_at.slice(0, 10));

  const [transcript, setTranscript] = useState<{ speaker: Line["speaker"]; text: string }[]>([]);
  const [isTyping, setIsTyping] = useState(false);

  const canSubmit = restaurantName.trim().length > 0 && phoneNumber.trim().length > 0;

  // Phase "connecting": fake dialing — ~7s before the line is picked up.
  useEffect(() => {
    if (phase !== "connecting") return;
    const t = setTimeout(() => setPhase("call"), 7000);
    return () => clearTimeout(t);
  }, [phase]);

  // Phase "call": reveal the scripted conversation word by word
  useEffect(() => {
    if (phase !== "call") return;
    let cancelled = false;
    setTranscript([]);

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    const run = async () => {
      const script = buildScript(partySize, time, formatDateLabel(date));
      for (let i = 0; i < script.length; i++) {
        const line = script[i];
        setIsTyping(true);
        // First line is Alfred's opening (the pickup wait is covered by the
        // "connecting" phase). Every later turn waits an extra random 1–2s so
        // the back-and-forth between speakers feels more lifelike.
        const extraPause = i === 0 ? 0 : 1000 + Math.random() * 1000;
        // Alfred "thinks" a touch longer before he speaks / replies.
        const alfredThink = line.speaker === "alfred" ? 700 + Math.random() * 500 : 0;
        await sleep(line.delayBefore + extraPause + alfredThink);
        if (cancelled) return;
        setIsTyping(false);

        setTranscript(t => [...t, { speaker: line.speaker, text: "" }]);
        const words = line.text.split(" ");
        let acc = "";
        for (const word of words) {
          await sleep(110 + Math.random() * 90);
          if (cancelled) return;
          acc = acc ? `${acc} ${word}` : word;
          setTranscript(t => {
            const copy = [...t];
            copy[copy.length - 1] = { ...copy[copy.length - 1], text: acc };
            return copy;
          });
        }
      }
      await sleep(900);
      if (!cancelled) setPhase("done");
    };

    run();
    return () => { cancelled = true; };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const speakerLabel = (s: Line["speaker"]) =>
    s === "alfred" ? "Alfred" : (restaurantName.trim() || "Restaurant");

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 12 }}>
        <MdPhone size={17} style={{ color: "var(--accent)", marginTop: 2 }} />
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
            Réservation — {event.title}
          </h2>
          {phase !== "form" && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
              {restaurantName.trim()} · {phoneNumber.trim()}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          style={{
            background: "none", border: "1px solid var(--border)", borderRadius: 6,
            padding: "3px 10px", cursor: "pointer", fontSize: 12, color: "var(--text-secondary)",
            transition: "background 0.15s, border-color 0.15s, color 0.15s",
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = "var(--active-bg)";
            e.currentTarget.style.borderColor = "var(--accent)";
            e.currentTarget.style.color = "var(--accent)";
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = "none";
            e.currentTarget.style.borderColor = "var(--border)";
            e.currentTarget.style.color = "var(--text-secondary)";
          }}
        >
          ✕ Fermer
        </button>
      </div>

      {/* ── Form ── */}
      {phase === "form" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={labelStyle}>Nom du restaurant</label>
              <input type="text" placeholder="Chez Marcel" value={restaurantName}
                onChange={e => setRestaurantName(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={labelStyle}>Numéro de téléphone</label>
              <input type="tel" placeholder="+33 1 23 45 67 89" value={phoneNumber}
                onChange={e => setPhoneNumber(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Nombre de personnes</label>
              <input type="number" min="1" max="20" value={partySize}
                onChange={e => setPartySize(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Heure</label>
              <input type="time" value={time}
                onChange={e => setTime(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={labelStyle}>Jour</label>
              <input type="date" value={date}
                onChange={e => setDate(e.target.value)} style={inputStyle} />
            </div>
          </div>
          <button
            onClick={() => canSubmit && setPhase("connecting")}
            disabled={!canSubmit}
            style={{
              background: "var(--accent)", color: "#fff", border: "none",
              borderRadius: 8, padding: "8px 20px",
              cursor: canSubmit ? "pointer" : "not-allowed",
              fontSize: 14, fontWeight: 500, opacity: canSubmit ? 1 : 0.6,
            }}
          >
            Valider — Alfred appelle
          </button>
        </>
      )}

      {/* ── Connecting (fake dialing) ── */}
      {phase === "connecting" && (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          gap: 10, padding: "28px 0", color: "var(--text-secondary)",
        }}>
          <style>{`
            .alfred-pulse { animation: alfredPulse 1.1s ease-in-out infinite; }
            @keyframes alfredPulse { 0%, 100% { transform: scale(1); opacity: 0.7; } 50% { transform: scale(1.18); opacity: 1; } }
          `}</style>
          <MdCall size={30} className="alfred-pulse" style={{ color: "var(--accent)" }} />
          <div style={{ fontSize: 13 }}>
            Alfred compose le {phoneNumber.trim()}… <TypingDots />
          </div>
        </div>
      )}

      {/* ── Live call transcript ── */}
      {(phase === "call" || phase === "done") && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {phase === "call" && (
            <div style={{
              fontSize: 11, fontWeight: 600, color: "#D4574E",
              display: "flex", alignItems: "center", gap: 6,
            }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#D4574E" }} className="alfred-pulse" />
              <style>{`@keyframes alfredPulse { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } } .alfred-pulse { animation: alfredPulse 1.1s infinite; }`}</style>
              APPEL EN COURS
            </div>
          )}

          {transcript.map((line, i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span style={{
                fontSize: 12, fontWeight: 600, flexShrink: 0, width: 90,
                textAlign: "right",
                color: line.speaker === "alfred" ? "var(--accent)" : "var(--text-primary)",
              }}>
                {speakerLabel(line.speaker)}
              </span>
              <span style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--text-secondary)" }}>
                {line.text}
              </span>
            </div>
          ))}

          {isTyping && (
            <div style={{ paddingLeft: 100 }}>
              <TypingDots />
            </div>
          )}

          {phase === "done" && (
            <div style={{
              marginTop: 6, padding: "10px 14px",
              background: "var(--active-bg)", borderRadius: 8,
              display: "flex", alignItems: "center", gap: 8,
              fontSize: 13, color: "var(--text-primary)",
            }}>
              <MdCheckCircle size={17} color="#34C759" />
              Appel terminé — table pour {partySize} réservée chez {restaurantName.trim()} le {formatDateLabel(date)} à {time}.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
