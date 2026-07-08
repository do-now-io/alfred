//! Chat history persistence (spec/10) — conversations are app state, stored in
//! SQLite (never in the vault). One exchange = a user turn + an assistant turn,
//! recorded together after `ask_notes` succeeds.
//!
//! Runtime (non-macro) queries: the tables land via migration 006 and aren't in
//! the compile-time dev database used by the `sqlx::query!` macros.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use ts_rs::TS;
use uuid::Uuid;

use super::chat::ChatSource;

/// Conversation title = first question, truncated for display (chars, not bytes).
const TITLE_MAX_CHARS: usize = 60;

/// What `ask_notes` returns to the UI: the answer plus the conversation it
/// landed in (freshly created on the first exchange).
#[derive(Debug, Serialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ChatExchangeResult {
    pub answer: String,
    pub sources: Vec<ChatSource>,
    pub conversation_id: String,
}

#[derive(Debug, Serialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ChatConversation {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct StoredChatMessage {
    pub id: String,
    pub role: String, // "user" | "assistant"
    pub content: String,
    pub sources: Option<Vec<ChatSource>>,
}

#[derive(Debug, Deserialize, sqlx::FromRow)]
struct MessageRow {
    id: String,
    role: String,
    content: String,
    sources_json: Option<String>,
}

fn make_title(question: &str) -> String {
    let clean = question.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= TITLE_MAX_CHARS {
        clean
    } else {
        let truncated: String = clean.chars().take(TITLE_MAX_CHARS).collect();
        format!("{}…", truncated.trim_end())
    }
}

/// Record one full exchange. Creates the conversation (titled after the first
/// question) when `conversation_id` is None. Returns the conversation id.
pub async fn record_exchange(
    db: &SqlitePool,
    conversation_id: Option<&str>,
    question: &str,
    answer: &str,
    sources: &[ChatSource],
) -> Result<String> {
    let now = chrono::Utc::now().to_rfc3339();

    let conv_id = match conversation_id {
        Some(id) => {
            sqlx::query("UPDATE chat_conversations SET updated_at = ? WHERE id = ?")
                .bind(&now)
                .bind(id)
                .execute(db)
                .await?;
            id.to_string()
        }
        None => {
            let id = Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO chat_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
                .bind(&id)
                .bind(make_title(question))
                .bind(&now)
                .bind(&now)
                .execute(db)
                .await?;
            id
        }
    };

    sqlx::query("INSERT INTO chat_messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)")
        .bind(Uuid::new_v4().to_string())
        .bind(&conv_id)
        .bind(question)
        .bind(&now)
        .execute(db)
        .await?;

    let sources_json = if sources.is_empty() {
        None
    } else {
        Some(serde_json::to_string(sources)?)
    };
    sqlx::query("INSERT INTO chat_messages (id, conversation_id, role, content, sources_json, created_at) VALUES (?, ?, 'assistant', ?, ?, ?)")
        .bind(Uuid::new_v4().to_string())
        .bind(&conv_id)
        .bind(answer)
        .bind(sources_json)
        .bind(&now)
        .execute(db)
        .await?;

    Ok(conv_id)
}

/// All conversations, most recently active first.
pub async fn list_conversations(db: &SqlitePool) -> Result<Vec<ChatConversation>> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, title, updated_at FROM chat_conversations ORDER BY updated_at DESC",
    )
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(id, title, updated_at)| ChatConversation { id, title, updated_at })
        .collect())
}

/// Full message list of one conversation, oldest first.
pub async fn get_messages(db: &SqlitePool, conversation_id: &str) -> Result<Vec<StoredChatMessage>> {
    let rows: Vec<MessageRow> = sqlx::query_as(
        "SELECT id, role, content, sources_json FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .bind(conversation_id)
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| StoredChatMessage {
            id: r.id,
            role: r.role,
            content: r.content,
            sources: r
                .sources_json
                .and_then(|j| serde_json::from_str(&j).ok()),
        })
        .collect())
}

/// Delete a conversation (messages cascade via FK).
pub async fn delete_conversation(db: &SqlitePool, conversation_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM chat_conversations WHERE id = ?")
        .bind(conversation_id)
        .execute(db)
        .await?;
    Ok(())
}
