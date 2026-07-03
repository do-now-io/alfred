use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::Emitter;
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Suggestion {
    pub id: String,
    #[ts(rename = "type")]
    pub suggestion_type: String,
    pub calendar_event_id: Option<String>,
    pub payload: String,
    pub status: String,
    pub created_at: String,
}

pub async fn get_suggestions(db: &SqlitePool) -> Result<Vec<Suggestion>> {
    let rows = sqlx::query!(
        r#"SELECT id as "id!", type as "suggestion_type!", calendar_event_id,
           payload as "payload!", status as "status!", created_at as "created_at!"
           FROM suggestions WHERE status = 'pending'
           ORDER BY created_at DESC"#
    )
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| Suggestion {
            id: r.id,
            suggestion_type: r.suggestion_type,
            calendar_event_id: r.calendar_event_id,
            payload: r.payload,
            status: r.status,
            created_at: r.created_at,
        })
        .collect())
}

/// Finds the restaurant_booking suggestion for a calendar event, or creates one.
/// Used by the "Demander à Alfred de réserver" button on meal events.
pub async fn create_booking_suggestion(event_id: &str, db: &SqlitePool) -> Result<Suggestion> {
    if let Some(r) = sqlx::query!(
        r#"SELECT id as "id!", type as "suggestion_type!", calendar_event_id,
           payload as "payload!", status as "status!", created_at as "created_at!"
           FROM suggestions WHERE calendar_event_id = ? AND type = 'restaurant_booking'"#,
        event_id
    )
    .fetch_optional(db)
    .await?
    {
        return Ok(Suggestion {
            id: r.id,
            suggestion_type: r.suggestion_type,
            calendar_event_id: r.calendar_event_id,
            payload: r.payload,
            status: r.status,
            created_at: r.created_at,
        });
    }

    let title = sqlx::query_scalar!("SELECT title FROM calendar_events WHERE id = ?", event_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Événement introuvable"))?;

    let payload = serde_json::json!({
        "restaurant_name": "",
        "phone_number": "",
        "reason": format!("Réservation pour \"{}\"", title)
    });
    let id = Uuid::new_v4().to_string();
    let payload_str = payload.to_string();
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query!(
        "INSERT INTO suggestions (id, type, calendar_event_id, payload, created_at) VALUES (?, 'restaurant_booking', ?, ?, ?)",
        id,
        event_id,
        payload_str,
        now
    )
    .execute(db)
    .await?;

    Ok(Suggestion {
        id,
        suggestion_type: "restaurant_booking".to_string(),
        calendar_event_id: Some(event_id.to_string()),
        payload: payload_str,
        status: "pending".to_string(),
        created_at: now,
    })
}

pub async fn accept_suggestion(id: &str, db: &SqlitePool) -> Result<()> {
    sqlx::query!("UPDATE suggestions SET status = 'accepted' WHERE id = ?", id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn dismiss_suggestion(id: &str, db: &SqlitePool) -> Result<()> {
    sqlx::query!("UPDATE suggestions SET status = 'dismissed' WHERE id = ?", id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn run_suggestion_engine(
    db: &SqlitePool,
    http_client: &reqwest::Client,
    app_handle: &tauri::AppHandle,
) -> Result<()> {
    let events = crate::calendar::get_week_events(db).await?;
    let now = chrono::Utc::now().to_rfc3339();

    for event in &events {
        let title_lower = event.title.to_lowercase();

        // Heuristic: lunch/dinner without location
        let is_meal = title_lower.contains("déjeuner")
            || title_lower.contains("lunch")
            || title_lower.contains("dîner")
            || title_lower.contains("dinner")
            || title_lower.contains("repas")
            || title_lower.contains("restaurant");

        if is_meal && event.location.is_none() {
            // Check if similar suggestion already dismissed
            let existing = sqlx::query_scalar!(
                "SELECT id FROM suggestions WHERE calendar_event_id = ? AND type = 'restaurant_booking'",
                event.id
            )
            .fetch_optional(db)
            .await?;

            if existing.is_none() {
                let payload = serde_json::json!({
                    "restaurant_name": "À définir",
                    "phone_number": "",
                    "reason": format!("Repas détecté sans lieu: \"{}\"", event.title)
                });
                let id = Uuid::new_v4().to_string();
                let payload_str = payload.to_string();
                sqlx::query!(
                    "INSERT INTO suggestions (id, type, calendar_event_id, payload, created_at) VALUES (?, 'restaurant_booking', ?, ?, ?)",
                    id,
                    event.id,
                    payload_str,
                    now
                )
                .execute(db)
                .await?;

                let _ = app_handle.emit("suggestion-ready", serde_json::json!({ "suggestion_id": id }));
            }
        }

        // Heuristic: travel without transport todo
        let is_travel = title_lower.contains("voyage")
            || title_lower.contains("trip")
            || title_lower.contains("déplacement")
            || title_lower.contains("conférence")
            || title_lower.contains("départ");

        if is_travel {
            let existing = sqlx::query_scalar!(
                "SELECT id FROM suggestions WHERE calendar_event_id = ? AND type = 'transport_check'",
                event.id
            )
            .fetch_optional(db)
            .await?;

            if existing.is_none() {
                let payload = serde_json::json!({
                    "destination": event.location.clone().unwrap_or_else(|| "Non précisé".to_string()),
                    "event_date": event.start_at.chars().take(10).collect::<String>(),
                    "reason": format!("Déplacement détecté: \"{}\"", event.title)
                });
                let id = Uuid::new_v4().to_string();
                let payload_str = payload.to_string();
                sqlx::query!(
                    "INSERT INTO suggestions (id, type, calendar_event_id, payload, created_at) VALUES (?, 'transport_check', ?, ?, ?)",
                    id,
                    event.id,
                    payload_str,
                    now
                )
                .execute(db)
                .await?;

                let _ = app_handle.emit("suggestion-ready", serde_json::json!({ "suggestion_id": id }));
            }
        }
    }

    Ok(())
}
