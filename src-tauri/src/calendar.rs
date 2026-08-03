//! Google Calendar (spec/02) — OAuth2 loopback flow (RFC 8252), sync
//! pull-based (aujourd'hui → +7j, cache SQLite), **lecture seule**. Apple
//! Calendar est explicitement hors scope (spec/02 §0 — cohérent avec le
//! retrait de l'entitlement `apple-events`, spec/12).
//!
//! Client OAuth Google : IMPORTANT pour qui configure la Google Cloud
//! Console — garder le client en statut **"Testing"** (pas de publication)
//! tant qu'on reste à l'échelle ~10 utilisateurs. Le scope
//! `calendar.readonly` est "sensible" chez Google : le publier déclenche une
//! vérification manuelle (délais de plusieurs semaines). En "Testing", les
//! testeurs (ajoutés par email dans la console, ~100 max) voient juste un
//! écran "app non vérifiée" à la 1ère connexion — acceptable à cette échelle.

use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use ts_rs::TS;

use crate::keychain;

const CLIENT_ID: Option<&str> = option_env!("ALFRED_GOOGLE_CLIENT_ID");
const CLIENT_SECRET: Option<&str> = option_env!("ALFRED_GOOGLE_CLIENT_SECRET");
const SCOPE: &str = "https://www.googleapis.com/auth/calendar.readonly";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
/// Fenêtre récupérée à chaque sync (spec/02 §2) — aujourd'hui → +7 jours.
const SYNC_WINDOW_DAYS: i64 = 7;
/// Le serveur de callback local se ferme s'il n'a rien reçu après ce délai
/// (spec/02 §1 — flow inchangé de l'ancienne version).
const OAUTH_TIMEOUT_SECS: u64 = 300;
/// Tolérance par défaut de `find_events_for_project` autour d'une fenêtre
/// temporelle (spec/02 §3c) — proposée par défaut, ajustable si besoin.
const WINDOW_TOLERANCE_MINUTES: i64 = 15;

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct GoogleAuthStatus {
    pub connected: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    pub start_at: String,
    pub end_at: String,
    pub location: Option<String>,
    pub description: Option<String>,
    pub attendees: Vec<String>,
    pub all_day: bool,
}

// ─── Identifiants OAuth (embarqués à la compilation) ─────────────────────────

fn client_creds() -> Result<(&'static str, &'static str)> {
    match (CLIENT_ID, CLIENT_SECRET) {
        (Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => Ok((id, secret)),
        _ => Err(anyhow!(
            "Client Google OAuth non configuré à la compilation (ALFRED_GOOGLE_CLIENT_ID / ALFRED_GOOGLE_CLIENT_SECRET)."
        )),
    }
}

// ─── Tokens (secrets.json, même mécanisme que la clé Claude perso) ───────────

struct StoredTokens {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
}

fn load_tokens() -> Result<Option<StoredTokens>> {
    let access_token = keychain::get_secret("google_access_token")?.filter(|s| !s.is_empty());
    let refresh_token = keychain::get_secret("google_refresh_token")?.filter(|s| !s.is_empty());
    let expires_at = keychain::get_secret("google_expires_at")?;
    let (Some(access_token), Some(refresh_token)) = (access_token, refresh_token) else {
        return Ok(None);
    };
    let expires_at = expires_at.and_then(|s| s.parse().ok()).unwrap_or(0);
    Ok(Some(StoredTokens { access_token, refresh_token, expires_at }))
}

fn store_tokens(access_token: &str, refresh_token: &str, expires_in: i64) -> Result<()> {
    let expires_at = (chrono::Utc::now().timestamp()) + expires_in;
    keychain::save_secret("google_access_token", access_token)?;
    keychain::save_secret("google_refresh_token", refresh_token)?;
    keychain::save_secret("google_expires_at", &expires_at.to_string())?;
    Ok(())
}

/// Statut pour Réglages (spec/02 §4) — reflète juste la présence de tokens
/// stockés (pas un test réseau), même logique que `email::get_imap_status`.
pub async fn get_calendar_auth_status() -> Result<GoogleAuthStatus> {
    Ok(GoogleAuthStatus { connected: load_tokens()?.is_some() })
}

/// Retire les tokens de `secrets.json` (spec/02 §1) — un compte à la fois.
pub async fn disconnect_google_calendar() -> Result<()> {
    keychain::delete_secret("google_access_token")?;
    keychain::delete_secret("google_refresh_token")?;
    keychain::delete_secret("google_expires_at")?;
    Ok(())
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
}

async fn exchange_code(client_id: &str, client_secret: &str, code: &str, redirect_uri: &str) -> Result<TokenResponse> {
    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(anyhow!("Échange du code OAuth échoué : {}", resp.text().await.unwrap_or_default()));
    }
    Ok(resp.json().await?)
}

async fn refresh_token(client_id: &str, client_secret: &str, refresh_token: &str) -> Result<TokenResponse> {
    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(anyhow!("Rafraîchissement du token Google échoué : {}", resp.text().await.unwrap_or_default()));
    }
    Ok(resp.json().await?)
}

/// Access token valide, rafraîchi si `expires_at - now < 5 min` (spec/02 §1).
/// `None` si aucun compte n'est connecté (permet l'appel inconditionnel au
/// démarrage, même logique que `email::sync_emails`).
async fn valid_access_token() -> Result<Option<String>> {
    let Some(tokens) = load_tokens()? else { return Ok(None) };
    let now = chrono::Utc::now().timestamp();
    if tokens.expires_at - now >= 300 {
        return Ok(Some(tokens.access_token));
    }
    let (client_id, client_secret) = client_creds()?;
    let refreshed = refresh_token(client_id, client_secret, &tokens.refresh_token).await?;
    store_tokens(
        &refreshed.access_token,
        refreshed.refresh_token.as_deref().unwrap_or(&tokens.refresh_token),
        refreshed.expires_in,
    )?;
    Ok(Some(refreshed.access_token))
}

// ─── Flow OAuth (spec/02 §1) ──────────────────────────────────────────────────

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter_map(|kv| {
            let mut it = kv.splitn(2, '=');
            let k = it.next()?;
            let v = it.next().unwrap_or("");
            Some((k.to_string(), urlencoding::decode(v).ok()?.to_string()))
        })
        .collect()
}

/// Accepte UNE requête HTTP sur le port local, valide `state` (anti-CSRF),
/// répond avec une page de confirmation, puis renvoie le `code`. Ignore les
/// requêtes qui ne correspondent pas (ex. favicon.ico) et continue d'attendre.
async fn accept_oauth_callback(listener: TcpListener, expected_state: &str) -> Result<String> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).await.unwrap_or(0);
        if n == 0 {
            continue;
        }
        let request = String::from_utf8_lossy(&buf[..n]).into_owned();
        let Some(first_line) = request.lines().next() else { continue };
        let Some(path) = first_line.split_whitespace().nth(1) else { continue };
        let query = path.split('?').nth(1).unwrap_or("");
        let params = parse_query(query);

        if params.get("state").map(String::as_str) != Some(expected_state) {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\n\r\n").await;
            continue;
        }

        if let Some(code) = params.get("code") {
            let body = "<html><body style=\"font-family:sans-serif;padding:40px\">Alfred est connecté à Google Calendar. Vous pouvez fermer cet onglet.</body></html>";
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\r\n{}", body.len(), body);
            let _ = stream.write_all(response.as_bytes()).await;
            return Ok(code.clone());
        }

        let error = params.get("error").cloned().unwrap_or_else(|| "inconnue".to_string());
        let body = format!("<html><body style=\"font-family:sans-serif;padding:40px\">Autorisation refusée par Google : {}</body></html>", error);
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\r\n{}", body.len(), body);
        let _ = stream.write_all(response.as_bytes()).await;
        return Err(anyhow!("Autorisation Google refusée ou en erreur : {}", error));
    }
}

/// Lance le flow OAuth complet (spec/02 §1) : serveur local → navigateur →
/// callback → échange du code → stockage des tokens.
pub async fn start_google_oauth() -> Result<()> {
    let (client_id, client_secret) = client_creds()?;

    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let redirect_uri = format!("http://127.0.0.1:{}", port);
    let state = uuid::Uuid::new_v4().to_string();

    let auth_url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&state={}",
        AUTH_URL,
        urlencoding::encode(client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(SCOPE),
        state,
    );

    tauri_plugin_opener::open_url(&auth_url, None::<String>)
        .map_err(|e| anyhow!("Impossible d'ouvrir le navigateur : {}", e))?;

    let code = tokio::time::timeout(
        std::time::Duration::from_secs(OAUTH_TIMEOUT_SECS),
        accept_oauth_callback(listener, &state),
    )
    .await
    .map_err(|_| anyhow!("Délai dépassé (5 min) — connexion Google annulée."))??;

    let tokens = exchange_code(client_id, client_secret, &code, &redirect_uri).await?;
    let refresh = tokens
        .refresh_token
        .ok_or_else(|| anyhow!("Google n'a pas renvoyé de refresh_token — réessayez la connexion."))?;
    store_tokens(&tokens.access_token, &refresh, tokens.expires_in)?;
    Ok(())
}

// ─── Sync (spec/02 §2) ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct GEventsPage {
    items: Vec<GEvent>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GEventDateTime {
    #[serde(rename = "dateTime")]
    date_time: Option<String>,
    date: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GAttendee {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GEvent {
    id: String,
    summary: Option<String>,
    location: Option<String>,
    description: Option<String>,
    start: GEventDateTime,
    end: GEventDateTime,
    attendees: Option<Vec<GAttendee>>,
    status: Option<String>,
}

async fn upsert_event(db: &SqlitePool, ev: &GEvent, synced_at: &str) -> Result<()> {
    if ev.status.as_deref() == Some("cancelled") {
        let _ = sqlx::query("DELETE FROM calendar_events WHERE source = 'google' AND external_id = ?")
            .bind(&ev.id)
            .execute(db)
            .await;
        return Ok(());
    }

    let title = ev.summary.clone().unwrap_or_else(|| "(Sans titre)".to_string());
    let all_day = ev.start.date_time.is_none();
    let start_at = ev.start.date_time.clone().or_else(|| ev.start.date.clone()).unwrap_or_default();
    let end_at = ev.end.date_time.clone().or_else(|| ev.end.date.clone()).unwrap_or_default();
    let attendees: Vec<String> = ev
        .attendees
        .as_ref()
        .map(|list| list.iter().filter_map(|a| a.display_name.clone().or_else(|| a.email.clone())).collect())
        .unwrap_or_default();
    let attendees_json = serde_json::to_string(&attendees).unwrap_or_else(|_| "[]".to_string());
    let id = format!("google:{}", ev.id);
    let all_day_int = all_day as i32;

    sqlx::query(
        "INSERT INTO calendar_events (id, source, external_id, title, start_at, end_at, location, description, attendees, all_day, last_synced_at)
         VALUES (?, 'google', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, external_id) DO UPDATE SET
            title = excluded.title, start_at = excluded.start_at, end_at = excluded.end_at,
            location = excluded.location, description = excluded.description,
            attendees = excluded.attendees, all_day = excluded.all_day, last_synced_at = excluded.last_synced_at",
    )
    .bind(&id)
    .bind(&ev.id)
    .bind(&title)
    .bind(&start_at)
    .bind(&end_at)
    .bind(&ev.location)
    .bind(&ev.description)
    .bind(&attendees_json)
    .bind(all_day_int)
    .bind(synced_at)
    .execute(db)
    .await?;
    Ok(())
}

/// Sync complète (spec/02 §2) — aujourd'hui → +7j, pagination `nextPageToken`,
/// upsert par `(source='google', external_id)`. No-op silencieux si aucun
/// compte n'est connecté (même logique que `email::sync_emails` — appel
/// inconditionnel au démarrage). Émet `calendar-synced` après un sync réussi.
pub async fn trigger_calendar_sync(db: &SqlitePool, app: &tauri::AppHandle) -> Result<()> {
    use tauri::Emitter;

    let Some(access_token) = valid_access_token().await? else {
        return Ok(());
    };

    let now = chrono::Utc::now();
    let time_min = now.to_rfc3339();
    let time_max = (now + chrono::Duration::days(SYNC_WINDOW_DAYS)).to_rfc3339();

    let client = reqwest::Client::new();
    let mut all_events: Vec<GEvent> = Vec::new();
    let mut page_token: Option<String> = None;
    loop {
        let mut req = client
            .get("https://www.googleapis.com/calendar/v3/calendars/primary/events")
            .bearer_auth(&access_token)
            .query(&[
                ("timeMin", time_min.as_str()),
                ("timeMax", time_max.as_str()),
                ("singleEvents", "true"),
                ("orderBy", "startTime"),
            ]);
        if let Some(pt) = &page_token {
            req = req.query(&[("pageToken", pt.as_str())]);
        }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            return Err(anyhow!("Google Calendar API : {}", resp.text().await.unwrap_or_default()));
        }
        let page: GEventsPage = resp.json().await?;
        page_token = page.next_page_token.clone();
        all_events.extend(page.items);
        if page_token.is_none() {
            break;
        }
    }

    let synced_at = chrono::Utc::now().to_rfc3339();
    for ev in &all_events {
        upsert_event(db, ev, &synced_at).await?;
    }

    let _ = app.emit("calendar-synced", serde_json::json!({ "event_count": all_events.len(), "synced_at": synced_at }));
    Ok(())
}

// ─── Lecture (écran Agenda §3a, brief §3b, chat §3d) ─────────────────────────

#[derive(sqlx::FromRow)]
struct EventRow {
    id: String,
    title: String,
    start_at: String,
    end_at: String,
    location: Option<String>,
    description: Option<String>,
    attendees: String,
    all_day: i64,
}

impl From<EventRow> for CalendarEvent {
    fn from(r: EventRow) -> Self {
        CalendarEvent {
            id: r.id,
            title: r.title,
            start_at: r.start_at,
            end_at: r.end_at,
            location: r.location,
            description: r.description,
            attendees: serde_json::from_str(&r.attendees).unwrap_or_default(),
            all_day: r.all_day != 0,
        }
    }
}

async fn list_cached_events(db: &SqlitePool) -> Result<Vec<CalendarEvent>> {
    let rows: Vec<EventRow> = sqlx::query_as(
        "SELECT id, title, start_at, end_at, location, description, attendees, all_day FROM calendar_events ORDER BY start_at ASC",
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(CalendarEvent::from).collect())
}

/// Parse `start_at`/`end_at` — soit un horodatage RFC3339 (événement daté),
/// soit une date seule `YYYY-MM-DD` (événement jour entier, minuit UTC).
fn parse_event_time(s: &str) -> Option<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|dt| DateTime::<Utc>::from_naive_utc_and_offset(dt, Utc))
}

fn overlaps(ev_start: DateTime<Utc>, ev_end: DateTime<Utc>, range_start: DateTime<Utc>, range_end: DateTime<Utc>) -> bool {
    ev_start < range_end && ev_end > range_start
}

/// Événements du jour (heure locale) — écran Agenda §3a + brief §3b.
pub async fn get_today_events(db: &SqlitePool) -> Result<Vec<CalendarEvent>> {
    let today = chrono::Local::now().date_naive();
    let range_start = local_midnight_utc(today);
    let range_end = local_midnight_utc(today + chrono::Duration::days(1));
    filter_by_range(db, range_start, range_end).await
}

/// Événements des 7 prochains jours (heure locale) — écran Agenda §3a.
pub async fn get_week_events(db: &SqlitePool) -> Result<Vec<CalendarEvent>> {
    let today = chrono::Local::now().date_naive();
    let range_start = local_midnight_utc(today);
    let range_end = local_midnight_utc(today + chrono::Duration::days(7));
    filter_by_range(db, range_start, range_end).await
}

fn local_midnight_utc(date: chrono::NaiveDate) -> DateTime<Utc> {
    use chrono::TimeZone;
    let naive = date.and_hms_opt(0, 0, 0).unwrap();
    chrono::Local
        .from_local_datetime(&naive)
        .single()
        .unwrap_or_else(|| chrono::Local.from_utc_datetime(&naive))
        .with_timezone(&Utc)
}

async fn filter_by_range(db: &SqlitePool, range_start: DateTime<Utc>, range_end: DateTime<Utc>) -> Result<Vec<CalendarEvent>> {
    let all = list_cached_events(db).await?;
    Ok(all
        .into_iter()
        .filter(|e| {
            let (Some(s), Some(en)) = (parse_event_time(&e.start_at), parse_event_time(&e.end_at)) else { return false };
            overlaps(s, en, range_start, range_end)
        })
        .collect())
}

fn normalize_for_match(s: &str) -> String {
    // Casse/accents (spec/02 §4) — décomposition Unicode puis retrait des
    // marques diacritiques, sans dépendance externe.
    s.chars()
        .flat_map(|c| c.to_lowercase())
        .filter(|c| !matches!(*c, '\u{0300}'..='\u{036f}'))
        .collect()
}

/// Heuristique partagée (spec/02 §4) — correspondance titre/participants
/// tolérante (casse/accents) et/ou chevauchement temporel avec tolérance de
/// ±`WINDOW_TOLERANCE_MINUTES`. Réutilisable :
/// - `project_name: Some(_)`, `window: None` → tous les événements dont le
///   titre ou un participant mentionne ce nom (ex. future agrégation projet,
///   spec/28, pas encore construite dans ce repo).
/// - `project_name: None`, `window: Some((start, end))` → événements
///   chevauchant cette fenêtre ± tolérance (spec/02 §3c — indice de
///   détection de projet à l'analyse d'une transcription).
/// - Les deux ensemble → intersection des deux critères.
pub async fn find_events_for_project(
    db: &SqlitePool,
    project_name: Option<&str>,
    window: Option<(DateTime<Utc>, DateTime<Utc>)>,
) -> Result<Vec<CalendarEvent>> {
    let all = list_cached_events(db).await?;
    let needle = project_name.map(normalize_for_match);
    let tolerance = chrono::Duration::minutes(WINDOW_TOLERANCE_MINUTES);
    let padded_window = window.map(|(s, e)| (s - tolerance, e + tolerance));

    Ok(all
        .into_iter()
        .filter(|e| {
            if let Some(n) = &needle {
                let title = normalize_for_match(&e.title);
                let matches_name = title.contains(n.as_str())
                    || e.attendees.iter().any(|a| normalize_for_match(a).contains(n.as_str()));
                if !matches_name {
                    return false;
                }
            }
            if let Some((rs, re)) = padded_window {
                let (Some(s), Some(en)) = (parse_event_time(&e.start_at), parse_event_time(&e.end_at)) else { return false };
                if !overlaps(s, en, rs, re) {
                    return false;
                }
            }
            true
        })
        .collect())
}
