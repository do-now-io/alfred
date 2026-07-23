use anyhow::Result;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};

async fn connect(db_path: &Path) -> Result<SqlitePool> {
    // Build the connect options from the path directly rather than a
    // `sqlite://…` URL string: on Windows an absolute path (drive letter +
    // backslashes) does not parse as a valid SQLite URL.
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .pragma("journal_mode", "WAL")
        .pragma("foreign_keys", "ON");

    Ok(SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?)
}

/// Moves aside a local `alfred.db` (+ its `-wal`/`-shm` sidecars) whose applied
/// migration history no longer matches this binary's embedded migrations — e.g.
/// after installing a build from a different commit/branch over a previous one
/// (same `%LOCALAPPDATA%\Alfred`), or reinstalling an older version. Safe to
/// discard: this DB holds only local config/state (CLAUDE.md) — Notes/Todo.md
/// live in the vault, untouched.
fn quarantine_db(db_path: &Path) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for suffix in ["", "-wal", "-shm"] {
        let from = PathBuf::from(format!("{}{}", db_path.display(), suffix));
        if from.exists() {
            let to = PathBuf::from(format!("{}.broken-{}{}", db_path.display(), ts, suffix));
            if let Err(e) = std::fs::rename(&from, &to) {
                eprintln!("[db] could not quarantine {:?}: {}", from, e);
            }
        }
    }
}

pub async fn init_pool(db_path: &Path) -> Result<SqlitePool> {
    let pool = connect(db_path).await?;

    if let Err(e) = sqlx::migrate!().run(&pool).await {
        pool.close().await;
        eprintln!(
            "[db] migration failed ({e}) — local database looks incompatible with this build, resetting it"
        );
        quarantine_db(db_path);

        let pool = connect(db_path).await?;
        sqlx::migrate!().run(&pool).await?;
        return Ok(pool);
    }

    Ok(pool)
}
