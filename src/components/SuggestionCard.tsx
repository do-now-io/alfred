import { MdRestaurant, MdPhone, MdTrain, MdLightbulb } from "react-icons/md";
import { useSuggestionStore } from "../store/suggestionStore";
import type { Suggestion } from "../bindings/Suggestion";

function SuggestionIcon({ type }: { type: string }) {
  const props = { size: 20 };
  switch (type) {
    case "restaurant_booking": return <MdRestaurant {...props} />;
    case "follow_up": return <MdPhone {...props} />;
    case "transport_check": return <MdTrain {...props} />;
    default: return <MdLightbulb {...props} />;
  }
}

interface Props {
  suggestion: Suggestion;
  onAccept?: (suggestion: Suggestion) => void;
}

export default function SuggestionCard({ suggestion, onAccept }: Props) {
  const { dismissSuggestion, acceptSuggestion } = useSuggestionStore();

  const payload = JSON.parse(suggestion.payload) as Record<string, string>;
  const label = payload.reason ?? payload.contact_name ?? payload.destination ?? "Suggestion";

  const handleAccept = () => {
    acceptSuggestion(suggestion.id);
    onAccept?.(suggestion);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "10px 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center", color: "var(--accent)" }}><SuggestionIcon type={suggestion.type} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.4 }}>{label}</div>
        {payload.restaurant_name && (
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
            {payload.restaurant_name}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        <button
          onClick={handleAccept}
          style={{
            background: "var(--accent)",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            padding: "4px 10px",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          Accepter
        </button>
        <button
          onClick={() => dismissSuggestion(suggestion.id)}
          style={{
            background: "transparent",
            color: "var(--text-secondary)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "4px 10px",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Ignorer
        </button>
      </div>
    </div>
  );
}
