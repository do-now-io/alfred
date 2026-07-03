use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct CalendarEvent {
    pub id: String,
    pub source: String,
    pub external_id: String,
    pub title: String,
    pub start_at: String,
    pub end_at: String,
    pub location: Option<String>,
    pub description: Option<String>,
    pub attendees: Option<String>,
    pub all_day: bool,
    pub last_synced_at: String,
}

pub async fn get_today_events(db: &SqlitePool) -> Result<Vec<CalendarEvent>> {
    let today_start = chrono::Local::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_local_timezone(chrono::Local)
        .unwrap()
        .to_rfc3339();
    let today_end = chrono::Local::now()
        .date_naive()
        .and_hms_opt(23, 59, 59)
        .unwrap()
        .and_local_timezone(chrono::Local)
        .unwrap()
        .to_rfc3339();

    let rows = sqlx::query!(
        r#"SELECT id as "id!", source as "source!", external_id as "external_id!",
           title as "title!", start_at as "start_at!", end_at as "end_at!",
           location, description, attendees, all_day as "all_day!", last_synced_at as "last_synced_at!"
           FROM calendar_events
           WHERE start_at >= ? AND start_at <= ?
           ORDER BY start_at ASC"#,
        today_start,
        today_end
    )
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| CalendarEvent {
            id: r.id,
            source: r.source,
            external_id: r.external_id,
            title: r.title,
            start_at: r.start_at,
            end_at: r.end_at,
            location: r.location,
            description: r.description,
            attendees: r.attendees,
            all_day: r.all_day != 0,
            last_synced_at: r.last_synced_at,
        })
        .collect())
}

pub async fn get_week_events(db: &SqlitePool) -> Result<Vec<CalendarEvent>> {
    let now = chrono::Local::now();
    let start = now.to_rfc3339();
    let end = (now + chrono::Duration::days(7)).to_rfc3339();

    let rows = sqlx::query!(
        r#"SELECT id as "id!", source as "source!", external_id as "external_id!",
           title as "title!", start_at as "start_at!", end_at as "end_at!",
           location, description, attendees, all_day as "all_day!", last_synced_at as "last_synced_at!"
           FROM calendar_events
           WHERE start_at >= ? AND start_at <= ?
           ORDER BY start_at ASC"#,
        start,
        end
    )
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| CalendarEvent {
            id: r.id,
            source: r.source,
            external_id: r.external_id,
            title: r.title,
            start_at: r.start_at,
            end_at: r.end_at,
            location: r.location,
            description: r.description,
            attendees: r.attendees,
            all_day: r.all_day != 0,
            last_synced_at: r.last_synced_at,
        })
        .collect())
}

/// Sync the connected Google account's primary calendar (next 7 days) into the
/// local DB. Returns silently with 0 if no account is connected. Token freshness
/// (refresh) is handled by `crate::auth::ensure_google_token_valid`.
pub async fn sync_google_calendar(
    db: &SqlitePool,
    http_client: &reqwest::Client,
) -> Result<usize> {
    let access_token = match crate::auth::ensure_google_token_valid(http_client).await {
        Ok(t) => t,
        Err(_) => return Ok(0), // Not connected or error — skip silently
    };

    let now = chrono::Utc::now();
    let time_min = now.format("%Y-%m-%dT00:00:00Z").to_string();
    let time_max = (now + chrono::Duration::days(7))
        .format("%Y-%m-%dT23:59:59Z")
        .to_string();

    let mut page_token: Option<String> = None;
    let mut total_count = 0;

    loop {
        let mut url = format!(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events\
             ?timeMin={}&timeMax={}&singleEvents=true&orderBy=startTime&maxResults=250",
            time_min, time_max
        );

        if let Some(ref token) = page_token {
            url.push_str(&format!("&pageToken={}", token));
        }

        let resp = http_client
            .get(&url)
            .bearer_auth(&access_token)
            .send()
            .await?
            .error_for_status()?
            .json::<serde_json::Value>()
            .await?;

        let sync_time = chrono::Utc::now().to_rfc3339();

        if let Some(items) = resp["items"].as_array() {
            for item in items {
                let ext_id = match item["id"].as_str() {
                    Some(id) => id,
                    None => continue,
                };
                let title = item["summary"].as_str().unwrap_or("(no title)");
                let start_at = item["start"]["dateTime"]
                    .as_str()
                    .or_else(|| item["start"]["date"].as_str())
                    .unwrap_or("");
                let end_at = item["end"]["dateTime"]
                    .as_str()
                    .or_else(|| item["end"]["date"].as_str())
                    .unwrap_or("");
                let all_day: i64 = if item["start"]["date"].is_string() { 1 } else { 0 };
                let location = item["location"].as_str();
                let description = item["description"].as_str();
                let attendees = item["attendees"].as_array().map(|arr| {
                    let emails: Vec<&str> = arr
                        .iter()
                        .filter_map(|a| a["email"].as_str())
                        .collect();
                    serde_json::to_string(&emails).unwrap_or_default()
                });

                let id = Uuid::new_v4().to_string();
                sqlx::query!(
                    r#"INSERT INTO calendar_events
                       (id, source, external_id, title, start_at, end_at,
                        location, description, attendees, all_day, last_synced_at)
                       VALUES (?, 'google', ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT (source, external_id) DO UPDATE SET
                         title = excluded.title,
                         start_at = excluded.start_at,
                         end_at = excluded.end_at,
                         location = excluded.location,
                         description = excluded.description,
                         attendees = excluded.attendees,
                         all_day = excluded.all_day,
                         last_synced_at = excluded.last_synced_at"#,
                    id,
                    ext_id,
                    title,
                    start_at,
                    end_at,
                    location,
                    description,
                    attendees,
                    all_day,
                    sync_time
                )
                .execute(db)
                .await?;
                total_count += 1;
            }
        }

        page_token = resp["nextPageToken"].as_str().map(|s| s.to_string());
        if page_token.is_none() {
            break;
        }
    }

    Ok(total_count)
}
