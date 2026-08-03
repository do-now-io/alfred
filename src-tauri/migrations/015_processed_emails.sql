-- spec/24 — connexion e-mails : dédoublonnage de la fenêtre glissante par
-- Message-ID (état local, jamais retraité même s'il réapparaît dans la fenêtre).
CREATE TABLE IF NOT EXISTS processed_emails (
    message_id TEXT PRIMARY KEY,
    processed_at TEXT NOT NULL
);
