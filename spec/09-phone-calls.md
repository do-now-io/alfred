# spec/09 — Phone Calls (Vapi)

> ⛔ **HORS V1 — reporté.** Les appels téléphoniques automatiques (Vapi) sont
> hors périmètre v1. Contenu conservé comme référence pour une phase future.
> Voir `spec/README.md`.

> **Décision fixée : D4**
> Polling toutes les 10s sur `GET /call/{id}` — pas de webhook (NAT laptop non fiable)

---

## Provider : Vapi.ai

Vapi est le provider choisi pour v1. La clé API est stockée dans Keychain (`vapi_api_key`).

Base URL : `https://api.vapi.ai`

---

## Flow complet

### Étape 1 — Accepter la suggestion

L'utilisateur accepte une suggestion `restaurant_booking`. L'UI s'ouvre sur l'écran de confirmation avec :
- Nom du restaurant (depuis `suggestions.payload.restaurant_name`)
- Numéro de téléphone (depuis `suggestions.payload.phone_number`)
- Champ : nombre de personnes (saisie numérique)
- Champ : heure souhaitée (saisie texte libre, ex : "20h30", "ce soir 8h")
- Bouton **Appeler**

Si `phone_number` est null dans le payload, un champ de saisie manuelle du numéro est affiché.

### Étape 2 — Lancer l'appel

Frontend appelle `initiate_phone_call(suggestion_id, party_size, requested_time)`.

Rust construit la requête Vapi :

```json
POST https://api.vapi.ai/call
Authorization: Bearer {VAPI_API_KEY}
Content-Type: application/json

{
  "phoneNumberId": null,
  "customer": {
    "number": "+33142000000"
  },
  "assistant": {
    "firstMessage": "Bonjour, j'appelle pour réserver une table.",
    "model": {
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001",
      "messages": [
        {
          "role": "system",
          "content": "Tu es un assistant qui appelle un restaurant pour faire une réservation. Tu dois réserver une table pour {PARTY_SIZE} personnes à {REQUESTED_TIME}. Le nom de la réservation est Tanguy. Sois poli, concis, et confirme bien la date, l'heure et le nombre de couverts avant de raccrocher. Si le restaurant est complet, demande les prochains créneaux disponibles et rapporte-les."
        }
      ]
    },
    "voice": {
      "provider": "azure",
      "voiceId": "fr-FR-HenriNeural"
    }
  }
}
```

⚠️ Note : Vapi nécessite un numéro de téléphone Vapi acheté (ou un trunk SIP) pour émettre des appels. Le `phoneNumberId` ci-dessus doit être l'ID du numéro Vapi acheté par l'utilisateur dans son dashboard Vapi. Ce numéro est configuré dans les Settings (`vapi_phone_number_id`).

### Étape 3 — Stocker l'appel en DB

```sql
INSERT INTO phone_calls (
    id, suggestion_id, provider, external_call_id,
    phone_number, party_size, requested_time,
    status, called_at
) VALUES (
    uuid(), ?, 'vapi', {call_id_from_vapi},
    ?, ?, ?,
    'in_progress', now()
);
```

Mettre à jour `suggestions.status = 'accepted'`.

### Étape 4 — Polling du statut

Une tâche Tokio poll `GET /call/{external_call_id}` toutes les 10 secondes :

```rust
async fn poll_call_status(call_id: &str, app: &AppHandle, state: &AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(10));
    loop {
        interval.tick().await;
        let response = get_vapi_call(call_id).await?;
        let status = response["status"].as_str().unwrap_or("unknown");

        app.emit("call-status-changed", serde_json::json!({
            "call_id": call_id,
            "status": status
        }))?;

        match status {
            "ended" | "failed" => {
                let summary = response["summary"].as_str().unwrap_or("").to_string();
                update_phone_call_completed(call_id, status, &summary, state).await?;
                break;
            }
            _ => continue,
        }
    }
}
```

Timeout du polling : 10 minutes maximum (600s). Si l'appel n'est pas terminé après 10 min, marquer `status = 'failed'` et afficher un message d'erreur.

### Étape 5 — Résultat

Quand l'appel se termine (`status = ended`), le résumé Vapi (transcription de l'appel ou summary) est stocké dans `phone_calls.result_summary`.

L'UI affiche le résumé à l'utilisateur : *"Réservation confirmée pour 4 personnes à 20h30"* (ou *"Le restaurant était complet — prochain créneau disponible : samedi 21h"*).

---

## Fallback

Si l'appel échoue (statut `failed`, numéro incorrect, pas de réponse) :
- Afficher le numéro de téléphone
- Bouton "Appeler directement" → `tauri::api::shell::open("tel:{phone_number}")`

---

## Commandes Tauri

```rust
#[tauri::command]
async fn initiate_phone_call(
    suggestion_id: String,
    params: CallParameters,
    // { party_size: u8, requested_time: String, phone_number_override: Option<String> }
    state: State<AppState>,
    app: AppHandle,
) -> Result<String, String>  // Retourne phone_call_id

#[tauri::command]
async fn get_call_status(
    call_id: String,
    state: State<AppState>,
) -> Result<PhoneCallStatus, String>

#[tauri::command]
async fn cancel_call(
    call_id: String,
    state: State<AppState>,
) -> Result<(), String>
// Appelle DELETE /call/{id} sur Vapi et met à jour status = 'cancelled'

#[tauri::command]
async fn list_phone_calls(state: State<AppState>) -> Result<Vec<PhoneCall>, String>
```

### Événements

```
"call-status-changed" → { call_id: string, status: "queued" | "ringing" | "in-progress" | "ended" | "failed" }
"call-completed"      → { call_id: string, result_summary: string }
```

---

## Configuration requise dans Settings (spec/11)

| Setting | Description |
|---|---|
| `vapi_api_key` | Clé API Vapi (Keychain) |
| `vapi_phone_number_id` | ID du numéro de téléphone Vapi acheté (SQLite config) |
| `google_places_api_key` | Clé Google Places pour la résolution des numéros de restaurant (Keychain) |
