//! Feedback submission (spec/14) — `POST /feedback` on the AlfredIA backend
//! (private alfred-backend repo §E, stores in Postgres). Backend-owned I/O per architecture
//! principle: the frontend never calls the network directly.

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::json;
use sqlx::SqlitePool;

const FEEDBACK_URL: &str = "https://api.alfred.do-now.io/feedback";

#[derive(Debug, Serialize)]
pub struct FeedbackImage {
    pub filename: Option<String>,
    pub content_type: Option<String>,
    /// Base64-encoded image bytes.
    pub data: String,
}

async fn install_id(db: &SqlitePool) -> Option<String> {
    sqlx::query_scalar("SELECT value FROM config WHERE key = 'install_id'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
}

pub async fn submit_feedback(
    category: &str,
    text: &str,
    contact_email: Option<&str>,
    view: Option<&str>,
    images: Vec<FeedbackImage>,
    app_version: &str,
    db: &SqlitePool,
    http: &reqwest::Client,
) -> Result<()> {
    if text.trim().is_empty() {
        return Err(anyhow!("Le texte du retour est vide"));
    }

    let body = json!({
        "category": category,
        "text": text,
        "contact_email": contact_email,
        "install_id": install_id(db).await,
        "app_version": app_version,
        "os": std::env::consts::OS,
        "view": view,
        "images": images,
    });

    let resp = http
        .post(FEEDBACK_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("Envoi impossible (réseau) : {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Le serveur a refusé l'envoi ({status}): {detail}"));
    }

    Ok(())
}
