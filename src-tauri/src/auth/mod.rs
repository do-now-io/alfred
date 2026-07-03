//! Account authentication (OAuth) for connecting a Google account.
//!
//! This module owns the "Sign in with Google" flow used during onboarding and
//! from Settings. Unlike the old flow (where the user pasted their own client
//! credentials), the OAuth client id/secret are *shipped* with the app — baked
//! at build time via `ALFRED_GOOGLE_CLIENT_ID` / `ALFRED_GOOGLE_CLIENT_SECRET`,
//! with a keychain fallback so dev builds can run without baked credentials.
//!
//! The flow is a loopback-redirect authorization-code exchange hardened with
//! PKCE (S256). Tokens are stored in the keychain; the connected account's
//! email + provider are stored too, for display.
//!
//! Microsoft support is planned for a later phase — `Provider` and the
//! account-status shape are intentionally provider-agnostic to accommodate it.

use anyhow::{anyhow, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use ts_rs::TS;

use crate::keychain;

/// Account providers Alfred can connect. Only Google is implemented today;
/// Microsoft is reserved for a later phase.
#[allow(dead_code)]
pub enum Provider {
    Google,
}

/// Status of the connected account, surfaced to the frontend.
#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct AccountStatus {
    pub connected: bool,
    pub provider: Option<String>,
    pub email: Option<String>,
}

// ─── Shipped OAuth credentials ──────────────────────────────────────────────
// Precedence: build-time env (shipped) wins; keychain is only a fallback so dev
// builds without baked credentials can still store creds locally.

fn google_client_id() -> Result<String> {
    if let Some(v) = option_env!("ALFRED_GOOGLE_CLIENT_ID").filter(|s| !s.is_empty()) {
        return Ok(v.to_string());
    }
    keychain::get_secret("google_client_id")?
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!(
            "Identifiant client Google absent (définir ALFRED_GOOGLE_CLIENT_ID au build, ou google_client_id en local)."
        ))
}

fn google_client_secret() -> Result<String> {
    if let Some(v) = option_env!("ALFRED_GOOGLE_CLIENT_SECRET").filter(|s| !s.is_empty()) {
        return Ok(v.to_string());
    }
    keychain::get_secret("google_client_secret")?
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Secret client Google absent."))
}

// ─── PKCE helpers ───────────────────────────────────────────────────────────

/// Random PKCE code verifier: 32 bytes of entropy (two UUIDs) → base64url, ~43 chars.
fn gen_code_verifier() -> String {
    let mut bytes = Vec::with_capacity(32);
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// S256 code challenge = base64url(SHA256(verifier)).
fn code_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

// ─── Google OAuth flow ──────────────────────────────────────────────────────

pub async fn start_google_oauth(
    app_handle: tauri::AppHandle,
    oauth_port: Arc<Mutex<Option<u16>>>,
    http_client: reqwest::Client,
) -> Result<()> {
    let client_id = google_client_id()?;
    let client_secret = google_client_secret()?;

    let verifier = gen_code_verifier();
    let challenge = code_challenge(&verifier);

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    *oauth_port.lock().await = Some(port);

    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);
    // Calendar + Gmail (read-only) + basic profile. Gmail scope is requested now
    // so the token is authorised for a future email feature, even though no email
    // UI exists yet.
    let scope = "openid email profile \
        https://www.googleapis.com/auth/calendar.readonly \
        https://www.googleapis.com/auth/gmail.readonly";

    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth\
         ?client_id={}&redirect_uri={}&response_type=code&scope={}\
         &access_type=offline&prompt=consent\
         &code_challenge={}&code_challenge_method=S256",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(scope),
        urlencoding::encode(&challenge),
    );

    tauri_plugin_opener::open_url(&auth_url, None::<String>)?;

    // Accept the loopback callback.
    let (mut stream, _) = listener.accept().await?;
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).await?;
    let request = String::from_utf8_lossy(&buf[..n]);

    // Parse `code` from request line: GET /callback?code=xxx HTTP/1.1
    let code = request
        .lines()
        .next()
        .and_then(|line| line.split('?').nth(1))
        .and_then(|query| {
            url::form_urlencoded::parse(query.split_whitespace().next().unwrap_or("").as_bytes())
                .find(|(k, _)| k == "code")
                .map(|(_, v)| v.to_string())
        })
        .ok_or_else(|| anyhow!("Aucun code dans le retour OAuth"))?;

    let html = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n\
        <html><body style=\"font-family:-apple-system,sans-serif;text-align:center;padding:48px\">\
        <h1>Alfred — compte connecté ✓</h1><p>Vous pouvez fermer cet onglet et revenir à Alfred.</p>\
        </body></html>";
    stream.write_all(html.as_bytes()).await?;

    // Exchange the code (with PKCE verifier) for tokens.
    let resp = http_client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code.as_str()),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;

    let access_token = resp["access_token"]
        .as_str()
        .ok_or_else(|| anyhow!("Pas d'access_token"))?
        .to_string();
    let refresh_token = resp["refresh_token"].as_str().unwrap_or("").to_string();
    let expires_in = resp["expires_in"].as_i64().unwrap_or(3600);
    let expires_at = (chrono::Utc::now() + chrono::Duration::seconds(expires_in)).to_rfc3339();

    keychain::save_secret("google_oauth_access_token", &access_token)?;
    if !refresh_token.is_empty() {
        keychain::save_secret("google_oauth_refresh_token", &refresh_token)?;
    }
    keychain::save_secret("google_oauth_expires_at", &expires_at)?;
    keychain::save_secret("account_provider", "google")?;

    // Best-effort: record the account email for display.
    if let Err(e) = fetch_and_store_email(&http_client, &access_token).await {
        eprintln!("[auth/google] could not fetch userinfo: {}", e);
    }

    *oauth_port.lock().await = None;

    let _ = app_handle.emit("google-oauth-connected", serde_json::json!({}));
    eprintln!("[auth/google] OAuth successful, tokens stored");
    Ok(())
}

async fn fetch_and_store_email(http_client: &reqwest::Client, access_token: &str) -> Result<()> {
    let resp = http_client
        .get("https://www.googleapis.com/oauth2/v3/userinfo")
        .bearer_auth(access_token)
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;
    if let Some(email) = resp["email"].as_str() {
        keychain::save_secret("account_email", email)?;
    }
    Ok(())
}

/// Returns a valid Google access token, refreshing it if it is within 5 minutes
/// of expiry. Errors if no account is connected.
pub async fn ensure_google_token_valid(http_client: &reqwest::Client) -> Result<String> {
    let access_token = keychain::get_secret("google_oauth_access_token")?
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Google non connecté"))?;

    let expires_at_str = match keychain::get_secret("google_oauth_expires_at")? {
        Some(s) if !s.is_empty() => s,
        _ => return Ok(access_token),
    };

    let expires_at = chrono::DateTime::parse_from_rfc3339(&expires_at_str)
        .map_err(|_| anyhow!("expires_at invalide"))?;

    if expires_at.signed_duration_since(chrono::Utc::now()).num_seconds() > 300 {
        return Ok(access_token);
    }

    // Refresh.
    let refresh_token = keychain::get_secret("google_oauth_refresh_token")?
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Pas de refresh token"))?;
    let client_id = google_client_id()?;
    let client_secret = google_client_secret()?;

    let resp = http_client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("refresh_token", refresh_token.as_str()),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;

    let new_access_token = resp["access_token"]
        .as_str()
        .ok_or_else(|| anyhow!("Pas d'access_token dans la réponse de refresh"))?;
    let expires_in = resp["expires_in"].as_i64().unwrap_or(3600);
    let new_expires_at = (chrono::Utc::now() + chrono::Duration::seconds(expires_in)).to_rfc3339();

    keychain::save_secret("google_oauth_access_token", new_access_token)?;
    keychain::save_secret("google_oauth_expires_at", &new_expires_at)?;

    Ok(new_access_token.to_string())
}

// ─── Account status / disconnect ────────────────────────────────────────────

pub fn get_account_status() -> AccountStatus {
    let connected = matches!(
        keychain::get_secret("google_oauth_access_token"),
        Ok(Some(ref t)) if !t.is_empty()
    );

    if !connected {
        return AccountStatus { connected: false, provider: None, email: None };
    }

    AccountStatus {
        connected: true,
        provider: keychain::get_secret("account_provider").ok().flatten().filter(|s| !s.is_empty()),
        email: keychain::get_secret("account_email").ok().flatten().filter(|s| !s.is_empty()),
    }
}

pub fn disconnect_account() -> Result<()> {
    for key in [
        "google_oauth_access_token",
        "google_oauth_refresh_token",
        "google_oauth_expires_at",
        "account_provider",
        "account_email",
    ] {
        keychain::delete_secret(key)?;
    }
    Ok(())
}
