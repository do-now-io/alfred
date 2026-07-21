//! AlfredIA subscription via loopback (spec/15, app side).
//!
//! Mirrors the OAuth loopback pattern (auth/mod.rs): bind 127.0.0.1 on an
//! ephemeral port, generate a nonce, send the browser to the backend
//! `/subscribe?nonce=…&port=…&plan=…`. After Stripe Checkout, the backend
//! 302-redirects to `http://127.0.0.1:<port>/callback?token=…` — we capture the
//! token, store it as `alfredia_token`, and switch `ai_mode` to `alfredia`.

use anyhow::{anyhow, Result};
use serde_json::json;
use sqlx::SqlitePool;
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::keychain;

const BACKEND_BASE: &str = "https://api.alfred.do-now.io";
/// The user has to complete a Stripe Checkout — leave them ample time.
const CALLBACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// Open the subscription page and wait for the token callback.
/// `plan` is `"monthly"` (default) or `"yearly"`.
pub async fn subscribe(plan: &str, db: &SqlitePool, app: &tauri::AppHandle) -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let nonce = uuid::Uuid::new_v4().simple().to_string();

    let url = format!(
        "{BACKEND_BASE}/subscribe?nonce={nonce}&port={port}&plan={}",
        urlencoding::encode(plan)
    );
    tauri_plugin_opener::open_url(&url, None::<String>)?;

    let token = tokio::time::timeout(CALLBACK_TIMEOUT, wait_for_token(&listener))
        .await
        .map_err(|_| anyhow!("Souscription expirée (aucun retour du navigateur). Réessaie depuis les Réglages."))??;

    keychain::save_secret("alfredia_token", &token)?;
    sqlx::query("INSERT OR REPLACE INTO config (key, value) VALUES ('ai_mode', 'alfredia')")
        .execute(db)
        .await?;

    let _ = app.emit("alfredia-subscribed", json!({ "ok": true }));
    Ok(())
}

/// Ask the backend for a Stripe Billing Portal session and open it in the
/// user's default browser (spec/15/11) — the desktop app never sees Stripe
/// customer/subscription ids, so this always goes through the backend.
pub async fn open_billing_portal(http: &reqwest::Client) -> Result<()> {
    let token = keychain::get_secret("alfredia_token")?
        .filter(|t| !t.is_empty())
        .ok_or_else(|| anyhow!("Aucun abonnement AlfredIA configuré"))?;

    let resp = http
        .post(format!("{BACKEND_BASE}/subscription/portal"))
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(anyhow!("Impossible d'ouvrir la gestion de l'abonnement. Réessaie plus tard."));
    }

    let body: serde_json::Value = resp.json().await?;
    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("Réponse invalide du serveur"))?;

    tauri_plugin_opener::open_url(url, None::<String>)?;
    Ok(())
}

/// Accept loopback connections until one carries `GET /callback?token=…`.
/// Browsers also probe `/favicon.ico` etc. — answer 404 and keep listening.
async fn wait_for_token(listener: &TcpListener) -> Result<String> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).await?;
        let request = String::from_utf8_lossy(&buf[..n]);

        let first_line = request.lines().next().unwrap_or("");
        if !first_line.contains("/callback") {
            let _ = stream
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                .await;
            continue;
        }

        let token = first_line
            .split('?')
            .nth(1)
            .and_then(|query| {
                url::form_urlencoded::parse(query.split_whitespace().next().unwrap_or("").as_bytes())
                    .find(|(k, _)| k == "token")
                    .map(|(_, v)| v.to_string())
            })
            .filter(|t| !t.is_empty());

        let (status, page) = match &token {
            Some(_) => (
                "200 OK",
                "<h1>Alfred — abonnement activé ✓</h1><p>Tu peux fermer cet onglet et revenir à Alfred.</p>",
            ),
            None => (
                "400 Bad Request",
                "<h1>Alfred — erreur</h1><p>Aucun token reçu. Réessaie depuis les Réglages.</p>",
            ),
        };
        let html = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n\
             <html><body style=\"font-family:-apple-system,sans-serif;text-align:center;padding:48px\">{page}</body></html>"
        );
        let _ = stream.write_all(html.as_bytes()).await;

        return token.ok_or_else(|| anyhow!("Aucun token dans le retour de souscription"));
    }
}
