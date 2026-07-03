use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use ts_rs::TS;
use uuid::Uuid;

use crate::keychain;

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct PhoneCall {
    pub id: String,
    pub suggestion_id: String,
    pub provider: String,
    pub external_call_id: Option<String>,
    pub phone_number: String,
    pub party_size: i64,
    pub requested_time: String,
    pub status: String,
    pub result_summary: Option<String>,
    pub called_at: Option<String>,
    pub completed_at: Option<String>,
}

pub async fn initiate_phone_call(
    suggestion_id: &str,
    phone_number: &str,
    party_size: i64,
    requested_time: &str,
    restaurant_name: Option<&str>,
    db: &SqlitePool,
    http_client: &reqwest::Client,
) -> Result<PhoneCall> {
    let vapi_key = keychain::get_secret("vapi_api_key")?
        .filter(|k| !k.is_empty())
        .ok_or_else(|| anyhow!("Vapi API key not configured"))?;

    let phone_number_id = sqlx::query_scalar!(
        "SELECT value FROM config WHERE key = 'vapi_phone_number_id'"
    )
    .fetch_optional(db)
    .await?
    .filter(|v| !v.is_empty())
    .ok_or_else(|| anyhow!("Vapi phone number ID not configured"))?;

    // Get event context from suggestion
    let suggestion = sqlx::query!(
        "SELECT payload, calendar_event_id FROM suggestions WHERE id = ?",
        suggestion_id
    )
    .fetch_optional(db)
    .await?
    .ok_or_else(|| anyhow!("Suggestion not found"))?;

    let mut payload: serde_json::Value = serde_json::from_str(&suggestion.payload)?;

    // The user may have entered/corrected the restaurant name in the booking form
    if let Some(name) = restaurant_name.filter(|n| !n.trim().is_empty()) {
        payload["restaurant_name"] = serde_json::json!(name.trim());
        payload["phone_number"] = serde_json::json!(phone_number);
        let payload_str = payload.to_string();
        let _ = sqlx::query!(
            "UPDATE suggestions SET payload = ? WHERE id = ?",
            payload_str,
            suggestion_id
        )
        .execute(db)
        .await;
    }

    let restaurant_name = payload["restaurant_name"]
        .as_str()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or("le restaurant");

    let system_prompt = format!(
        "You are a friendly assistant calling to book a table at {}. \
         Book a table for {} people at {}. \
         Be polite, confirm the booking details, and get a confirmation number if possible.",
        restaurant_name, party_size, requested_time
    );

    let call_body = serde_json::json!({
        "phoneNumberId": phone_number_id,
        "customer": {
            "number": phone_number
        },
        "assistant": {
            "firstMessage": format!(
                "Bonjour, je souhaite réserver une table pour {} personnes ce soir à {}. Est-ce possible ?",
                party_size, requested_time
            ),
            "model": {
                "provider": "anthropic",
                "model": "claude-haiku-4-5-20251001",
                "messages": [{"role": "system", "content": system_prompt}]
            },
            "voice": {
                "provider": "11labs",
                "voiceId": "burt"
            }
        }
    });

    let resp = http_client
        .post("https://api.vapi.ai/call")
        .bearer_auth(&vapi_key)
        .json(&call_body)
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;

    let external_call_id = resp["id"].as_str().map(|s| s.to_string());

    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query!(
        r#"INSERT INTO phone_calls
           (id, suggestion_id, provider, external_call_id, phone_number, party_size, requested_time, status, called_at)
           VALUES (?, ?, 'vapi', ?, ?, ?, ?, 'in_progress', ?)"#,
        id,
        suggestion_id,
        external_call_id,
        phone_number,
        party_size,
        requested_time,
        now
    )
    .execute(db)
    .await?;

    // Accept the suggestion
    let _ = crate::suggestions::accept_suggestion(suggestion_id, db).await;

    get_call_by_id(&id, db).await
}

pub async fn get_call_status(
    call_id: &str,
    db: &SqlitePool,
    http_client: &reqwest::Client,
) -> Result<PhoneCall> {
    let call = get_call_by_id(call_id, db).await?;

    // Poll Vapi for status if in_progress
    if call.status == "in_progress" {
        if let Some(ref ext_id) = call.external_call_id {
            let vapi_key = keychain::get_secret("vapi_api_key")?
                .filter(|k| !k.is_empty())
                .ok_or_else(|| anyhow!("Vapi API key not configured"))?;

            let resp = http_client
                .get(format!("https://api.vapi.ai/call/{}", ext_id))
                .bearer_auth(&vapi_key)
                .send()
                .await?
                .error_for_status()?
                .json::<serde_json::Value>()
                .await?;

            let vapi_status = resp["status"].as_str().unwrap_or("unknown");
            let new_status = match vapi_status {
                "ended" | "forwarding-ended" => "completed",
                "failed" | "no-answer" | "busy" => "failed",
                _ => "in_progress",
            };

            if new_status != "in_progress" {
                let now = chrono::Utc::now().to_rfc3339();
                let transcript = resp["transcript"].as_str().map(|s| s.to_string());
                sqlx::query!(
                    "UPDATE phone_calls SET status = ?, completed_at = ?, result_summary = ? WHERE id = ?",
                    new_status,
                    now,
                    transcript,
                    call_id
                )
                .execute(db)
                .await?;
            }
        }
    }

    get_call_by_id(call_id, db).await
}

async fn get_call_by_id(id: &str, db: &SqlitePool) -> Result<PhoneCall> {
    let r = sqlx::query!(
        r#"SELECT id as "id!", suggestion_id as "suggestion_id!", provider as "provider!",
           external_call_id, phone_number as "phone_number!", party_size as "party_size!",
           requested_time as "requested_time!", status as "status!",
           result_summary, called_at, completed_at
           FROM phone_calls WHERE id = ?"#,
        id
    )
    .fetch_one(db)
    .await?;

    Ok(PhoneCall {
        id: r.id,
        suggestion_id: r.suggestion_id,
        provider: r.provider,
        external_call_id: r.external_call_id,
        phone_number: r.phone_number,
        party_size: r.party_size,
        requested_time: r.requested_time,
        status: r.status,
        result_summary: r.result_summary,
        called_at: r.called_at,
        completed_at: r.completed_at,
    })
}
