//! Note sharing (spec/18) — upload a note's Markdown to the AlfredIA backend and
//! get a public-by-link URL. Create-or-update (same URL) keyed by a stable local
//! key (the note path). The `manage_token` returned at creation is kept locally
//! (SQLite `note_shares`) to update or revoke later.

use anyhow::{anyhow, Result};
use serde::Deserialize;
use serde_json::json;
use sqlx::SqlitePool;

const SHARE_BASE: &str = "https://api.alfred.do-now.io";

#[derive(Deserialize)]
struct ShareCreated {
    slug: String,
    url: String,
    manage_token: String,
}

async fn install_id(db: &SqlitePool) -> Option<String> {
    sqlx::query_scalar("SELECT value FROM config WHERE key = 'install_id'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
}

/// (slug, manage_token, url) for an already-shared key.
async fn local_share(db: &SqlitePool, key: &str) -> Option<(String, String, String)> {
    sqlx::query_as("SELECT slug, manage_token, url FROM note_shares WHERE note_path = ?")
        .bind(key)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
}

async fn store_local(db: &SqlitePool, key: &str, slug: &str, manage_token: &str, url: &str) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT OR REPLACE INTO note_shares (note_path, slug, manage_token, url, created_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(key)
    .bind(slug)
    .bind(manage_token)
    .bind(url)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

/// Create the share, or update it in place (same URL) if `key` is already shared.
pub async fn upload_share(
    db: &SqlitePool,
    http: &reqwest::Client,
    key: &str,
    title: &str,
    markdown: &str,
) -> Result<String> {
    // Existing share → update on the same URL (PUT).
    if let Some((slug, manage_token, url)) = local_share(db, key).await {
        let resp = http
            .put(format!("{SHARE_BASE}/share/{slug}"))
            .json(&json!({ "manage_token": manage_token, "title": title, "markdown": markdown }))
            .send()
            .await?;
        if resp.status().is_success() {
            return Ok(url);
        }
        // 404 → the server no longer has it; fall through and recreate.
        if resp.status() != reqwest::StatusCode::NOT_FOUND {
            return Err(anyhow!("Mise à jour du partage échouée ({})", resp.status()));
        }
    }

    // Create (POST).
    let iid = install_id(db).await;
    let resp = http
        .post(format!("{SHARE_BASE}/share"))
        .json(&json!({ "title": title, "markdown": markdown, "install_id": iid }))
        .send()
        .await?
        .error_for_status()?;
    let created: ShareCreated = resp.json().await?;
    store_local(db, key, &created.slug, &created.manage_token, &created.url).await?;
    Ok(created.url)
}

/// Revoke a share (best-effort DELETE) and forget it locally.
pub async fn remove_share(db: &SqlitePool, http: &reqwest::Client, key: &str) -> Result<()> {
    if let Some((slug, manage_token, _url)) = local_share(db, key).await {
        let _ = http
            .delete(format!("{SHARE_BASE}/share/{slug}"))
            .header("x-manage-token", manage_token)
            .send()
            .await;
        sqlx::query("DELETE FROM note_shares WHERE note_path = ?")
            .bind(key)
            .execute(db)
            .await?;
    }
    Ok(())
}

/// The public URL if `key` is currently shared, else `None`.
pub async fn share_link(db: &SqlitePool, key: &str) -> Option<String> {
    local_share(db, key).await.map(|(_, _, url)| url)
}
