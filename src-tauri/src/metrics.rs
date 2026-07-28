//! Anonymous usage metrics (backend privé alfred-backend §D).
//!
//! Fire-and-forget POSTs to the AlfredIA backend. Always on, no PII: a local
//! random `install_id` (UUID, stored in config) decoupled from any Stripe
//! identity. Failures are silently dropped — metrics must never hurt the app.

use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::sync::OnceLock;

const METRICS_URL: &str = "https://api.alfred.do-now.io/metrics";

/// Anti-spam key (backend privé alfred-backend §D) — baked in at **compile time** from the
/// `ALFRED_METRICS_APP_KEY` build env var (set in CI, see
/// `.github/workflows/desktop-build.yml`), sent back as `x-metrics-key`. Must
/// match the backend's `METRICS_APP_KEY` (Coolify). Empty/unset in local dev
/// builds — the backend only enforces the header when it has a key configured
/// (open otherwise), so this is safe either way.
const METRICS_APP_KEY: Option<&str> = option_env!("ALFRED_METRICS_APP_KEY");

struct Ctx {
    http: reqwest::Client,
    install_id: String,
    app_version: String,
}

static CTX: OnceLock<Ctx> = OnceLock::new();

/// Ensure the anonymous install id exists, then arm the sender.
/// Emits `install_created` on the very first launch, then `app_launched`.
pub async fn init(db: &SqlitePool, http: reqwest::Client, app_version: &str) {
    let existing: Option<String> =
        sqlx::query_scalar("SELECT value FROM config WHERE key = 'install_id'")
            .fetch_optional(db)
            .await
            .ok()
            .flatten();

    let (install_id, created) = match existing.filter(|v| !v.is_empty()) {
        Some(id) => (id, false),
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            let _ = sqlx::query("INSERT OR REPLACE INTO config (key, value) VALUES ('install_id', ?)")
                .bind(&id)
                .execute(db)
                .await;
            (id, true)
        }
    };

    let _ = CTX.set(Ctx {
        http,
        install_id,
        app_version: app_version.to_string(),
    });

    if created {
        send("install_created", json!({}));
    }
    send("app_launched", json!({}));
}

/// Fire-and-forget event. Never blocks or fails the caller; no-op before init.
pub fn send(event: &str, props: Value) {
    let Some(ctx) = CTX.get() else { return };
    let body = json!({
        "install_id": ctx.install_id,
        "event": event,
        "props": props,
        "app_version": ctx.app_version,
        "os": std::env::consts::OS,
    });
    let http = ctx.http.clone();
    tauri::async_runtime::spawn(async move {
        let mut req = http.post(METRICS_URL).json(&body);
        if let Some(key) = METRICS_APP_KEY.filter(|k| !k.is_empty()) {
            req = req.header("x-metrics-key", key);
        }
        let _ = req.send().await;
    });
}
