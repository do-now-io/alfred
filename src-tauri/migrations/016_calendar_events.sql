-- spec/02 — Google Calendar (contexte actif). L'ancienne table `calendar_events`
-- (Apple + Google) a été droppée en Phase D (migration 008) ; celle-ci ne
-- couvre plus que Google (Apple Calendar hors scope, spec/02 §0).
CREATE TABLE calendar_events (
    id             TEXT PRIMARY KEY,
    source         TEXT NOT NULL CHECK (source IN ('google')),
    external_id    TEXT NOT NULL,
    title          TEXT NOT NULL,
    start_at       TEXT NOT NULL,
    end_at         TEXT NOT NULL,
    location       TEXT,
    description    TEXT,
    attendees      TEXT NOT NULL DEFAULT '[]',
    all_day        INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT NOT NULL,
    UNIQUE (source, external_id)
);
CREATE INDEX idx_calendar_events_start ON calendar_events (start_at);
