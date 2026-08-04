-- spec/24 §5 — écran de validation des mails : remplace l'écriture directe de
-- l'ancien §4. Une ligne par item proposé (tâche ou fait de contexte), jamais
-- par batch — granularité item par item (décision actée spec/24 §5).
CREATE TABLE IF NOT EXISTS pending_email_reviews (
    id INTEGER PRIMARY KEY,
    message_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    email_date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('task', 'context')),
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at TEXT NOT NULL
);
CREATE INDEX idx_pending_email_reviews_status ON pending_email_reviews (status);
