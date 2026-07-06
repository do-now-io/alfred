use anyhow::Result;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::Path;

pub async fn init_pool(db_path: &Path) -> Result<SqlitePool> {
    // Build the connect options from the path directly rather than a
    // `sqlite://…` URL string: on Windows an absolute path (drive letter +
    // backslashes) does not parse as a valid SQLite URL.
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .pragma("journal_mode", "WAL")
        .pragma("foreign_keys", "ON");

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    sqlx::migrate!().run(&pool).await?;

    Ok(pool)
}
