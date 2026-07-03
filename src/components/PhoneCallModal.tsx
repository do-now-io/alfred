import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MdRestaurant, MdLocationOn, MdWarning, MdPhone, MdCheckCircle } from "react-icons/md";
import type { Suggestion } from "../bindings/Suggestion";

interface Props {
  suggestion: Suggestion;
  onClose: () => void;
}

export default function PhoneCallModal({ suggestion, onClose }: Props) {
  const payload = JSON.parse(suggestion.payload) as Record<string, string>;
  const initialName = payload.restaurant_name && payload.restaurant_name !== "À définir" ? payload.restaurant_name : "";
  const [restaurantName, setRestaurantName] = useState(initialName);
  const [phoneNumber, setPhoneNumber] = useState(payload.phone_number ?? "");
  const [partySize, setPartySize] = useState("2");
  const [requestedTime, setRequestedTime] = useState("20:00");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const canCall = phoneNumber.trim().length > 0 && !loading;

  const handleCall = async () => {
    setLoading(true);
    setError(null);
    try {
      await invoke("initiate_phone_call", {
        suggestionId: suggestion.id,
        phoneNumber: phoneNumber.trim(),
        partySize: parseInt(partySize),
        requestedTime,
        restaurantName: restaurantName.trim() || null,
      });
      setSuccess(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 360, padding: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 16, color: "var(--text-primary)" }}>
          <MdRestaurant style={{ verticalAlign: "middle", marginRight: 6 }} /> Réserver — {restaurantName.trim() || "Restaurant"}
        </h3>

        {payload.address && (
          <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12, display: "flex", alignItems: "center", gap: 4 }}>
            <MdLocationOn size={15} /> {payload.address}
          </div>
        )}

        {!success ? (
          <>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                Restaurant
              </label>
              <input
                type="text"
                placeholder="Nom du restaurant"
                value={restaurantName}
                onChange={(e) => setRestaurantName(e.target.value)}
                style={{
                  width: "100%",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 14,
                  background: "var(--card-bg)",
                  color: "var(--text-primary)",
                }}
              />
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                Numéro de téléphone
              </label>
              <input
                type="tel"
                placeholder="+33 1 23 45 67 89"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                style={{
                  width: "100%",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 14,
                  background: "var(--card-bg)",
                  color: "var(--text-primary)",
                }}
              />
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                Nombre de personnes
              </label>
              <input
                type="number"
                min="1"
                max="20"
                value={partySize}
                onChange={(e) => setPartySize(e.target.value)}
                style={{
                  width: "100%",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 14,
                  background: "var(--card-bg)",
                  color: "var(--text-primary)",
                }}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 13, color: "var(--text-secondary)", display: "block", marginBottom: 4 }}>
                Heure souhaitée
              </label>
              <input
                type="time"
                value={requestedTime}
                onChange={(e) => setRequestedTime(e.target.value)}
                style={{
                  width: "100%",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 14,
                  background: "var(--card-bg)",
                  color: "var(--text-primary)",
                }}
              />
            </div>

            {error && (
              <div style={{ color: "var(--danger)", fontSize: 13, marginBottom: 12, display: "flex", alignItems: "center", gap: 4 }}><MdWarning size={15} /> {error}</div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={handleCall}
                disabled={!canCall}
                style={{
                  flex: 1,
                  background: "var(--accent)",
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  padding: "8px",
                  cursor: !canCall ? "not-allowed" : "pointer",
                  fontSize: 14,
                  opacity: !canCall ? 0.7 : 1,
                }}
              >
                {loading ? "Appel en cours..." : <><MdPhone style={{ verticalAlign: "middle", marginRight: 4 }} /> Appeler</>}
              </button>
              <button
                onClick={onClose}
                style={{
                  background: "transparent",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "8px 16px",
                  cursor: "pointer",
                  fontSize: 14,
                }}
              >
                Annuler
              </button>
            </div>
          </>
        ) : (
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <div style={{ fontSize: 32, marginBottom: 8, display: "flex", justifyContent: "center" }}><MdCheckCircle size={36} color="#34C759" /></div>
            <div style={{ fontSize: 14, color: "var(--text-primary)" }}>
              Appel initié. Vous serez notifié du résultat.
            </div>
            <button
              onClick={onClose}
              style={{
                marginTop: 16,
                background: "var(--accent)",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "8px 20px",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              Fermer
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
