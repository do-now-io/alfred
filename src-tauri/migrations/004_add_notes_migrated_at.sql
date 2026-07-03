-- Track which SQLite notes have been exported to the vault
ALTER TABLE notes ADD COLUMN migrated_at TEXT;
