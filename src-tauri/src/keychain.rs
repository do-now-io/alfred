//! Secret storage backed by a plain JSON file in the app data directory.
//!
//! This used to use the macOS keychain (security-framework), but every dev
//! rebuild changes the binary signature and macOS re-prompts for the login
//! password on each access. Secrets are now stored in `secrets.json` next to
//! the app database instead (file mode 0o600).

use anyhow::Result;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static STORE_DIR: OnceLock<PathBuf> = OnceLock::new();
static FILE_LOCK: Mutex<()> = Mutex::new(());

/// Called once at app setup with the real app data dir.
pub fn init(dir: PathBuf) {
    let _ = STORE_DIR.set(dir);
}

fn secrets_path() -> PathBuf {
    STORE_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| {
            dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("com.alfred.app")
        })
        .join("secrets.json")
}

fn read_all() -> HashMap<String, String> {
    std::fs::read_to_string(secrets_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_all(map: &HashMap<String, String>) -> Result<()> {
    let path = secrets_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(map)?)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

pub fn save_secret(account: &str, value: &str) -> Result<()> {
    let _guard = FILE_LOCK.lock().unwrap();
    let mut map = read_all();
    if value.is_empty() {
        map.remove(account);
    } else {
        map.insert(account.to_string(), value.to_string());
    }
    write_all(&map)
}

pub fn get_secret(account: &str) -> Result<Option<String>> {
    let _guard = FILE_LOCK.lock().unwrap();
    Ok(read_all().get(account).cloned())
}

#[allow(dead_code)]
pub fn delete_secret(account: &str) -> Result<()> {
    save_secret(account, "")
}
