use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Todo {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub source: String,
    pub source_id: Option<String>,
    pub status: String,
    pub due_date: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct CreateTodoInput {
    pub title: String,
    pub description: Option<String>,
    pub source: String,
    pub source_id: Option<String>,
    pub due_date: Option<String>,
}

pub async fn get_todos(db: &SqlitePool) -> Result<Vec<Todo>> {
    let rows = sqlx::query!(
        r#"SELECT id as "id!", title as "title!", description, source as "source!",
           source_id, status as "status!", due_date, created_at as "created_at!", updated_at as "updated_at!"
           FROM todos WHERE status = 'pending'
           ORDER BY CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC, created_at ASC"#
    )
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| Todo {
            id: r.id,
            title: r.title,
            description: r.description,
            source: r.source,
            source_id: r.source_id,
            status: r.status,
            due_date: r.due_date,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
        .collect())
}

pub async fn create_todo_internal(
    title: &str,
    description: Option<&str>,
    source: &str,
    source_id: Option<&str>,
    due_date: Option<&str>,
    db: &SqlitePool,
) -> Result<Todo> {
    // Deduplication: check (source, source_id, title_hash)
    if let Some(sid) = source_id {
        let title_hash = compute_title_hash(title);
        let existing = sqlx::query_scalar!(
            "SELECT id FROM todos WHERE source = ? AND source_id = ? AND title = ?",
            source,
            sid,
            title
        )
        .fetch_optional(db)
        .await?;

        if let Some(Some(id)) = existing {
            let _ = title_hash; // suppress unused warning
            return get_todo_by_id(&id, db).await;
        }
    }

    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query!(
        r#"INSERT INTO todos (id, title, description, source, source_id, due_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)"#,
        id,
        title,
        description,
        source,
        source_id,
        due_date,
        now,
        now
    )
    .execute(db)
    .await?;

    get_todo_by_id(&id, db).await
}

async fn get_todo_by_id(id: &str, db: &SqlitePool) -> Result<Todo> {
    let r = sqlx::query!(
        r#"SELECT id as "id!", title as "title!", description, source as "source!",
           source_id, status as "status!", due_date, created_at as "created_at!", updated_at as "updated_at!"
           FROM todos WHERE id = ?"#,
        id
    )
    .fetch_one(db)
    .await?;

    Ok(Todo {
        id: r.id,
        title: r.title,
        description: r.description,
        source: r.source,
        source_id: r.source_id,
        status: r.status,
        due_date: r.due_date,
        created_at: r.created_at,
        updated_at: r.updated_at,
    })
}

fn compute_title_hash(title: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(title.to_lowercase().trim().as_bytes());
    hex::encode(hasher.finalize())
}

pub async fn complete_todo(id: &str, db: &SqlitePool) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query!(
        "UPDATE todos SET status = 'done', updated_at = ? WHERE id = ?",
        now,
        id
    )
    .execute(db)
    .await?;
    Ok(())
}

pub async fn dismiss_todo(id: &str, db: &SqlitePool) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query!(
        "UPDATE todos SET status = 'dismissed', updated_at = ? WHERE id = ?",
        now,
        id
    )
    .execute(db)
    .await?;
    Ok(())
}

pub async fn update_todo(id: &str, input: &CreateTodoInput, db: &SqlitePool) -> Result<Todo> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query!(
        "UPDATE todos SET title = ?, description = ?, due_date = ?, updated_at = ? WHERE id = ?",
        input.title,
        input.description,
        input.due_date,
        now,
        id
    )
    .execute(db)
    .await?;
    get_todo_by_id(id, db).await
}
