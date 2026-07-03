-- calendar_events
CREATE TABLE calendar_events (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL CHECK (source IN ('google', 'apple')),
    external_id TEXT NOT NULL,
    title       TEXT NOT NULL,
    start_at    TEXT NOT NULL,
    end_at      TEXT NOT NULL,
    location    TEXT,
    description TEXT,
    attendees   TEXT,
    all_day     INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT NOT NULL,
    UNIQUE (source, external_id)
);
CREATE INDEX idx_calendar_events_start ON calendar_events (start_at);

-- recordings
CREATE TABLE recordings (
    id          TEXT PRIMARY KEY,
    file_path   TEXT NOT NULL,
    duration_seconds INTEGER,
    recorded_at TEXT NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('mic_only', 'system_only', 'mixed')),
    status      TEXT NOT NULL DEFAULT 'recording'
                    CHECK (status IN ('recording', 'processing', 'done', 'failed'))
);

-- transcriptions
CREATE TABLE transcriptions (
    id              TEXT PRIMARY KEY,
    recording_id    TEXT NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
    raw_text        TEXT NOT NULL,
    segments_json   TEXT NOT NULL,
    language        TEXT,
    whisper_model   TEXT NOT NULL,
    processed_at    TEXT NOT NULL
);
CREATE INDEX idx_transcriptions_recording ON transcriptions (recording_id);

-- todos
CREATE TABLE todos (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT,
    source      TEXT NOT NULL CHECK (source IN ('transcription', 'suggestion', 'manual')),
    source_id   TEXT,
    status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'done', 'dismissed')),
    due_date    TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX idx_todos_status ON todos (status);
CREATE INDEX idx_todos_due_date ON todos (due_date);

-- notes
CREATE TABLE notes (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL DEFAULT '',
    recording_id TEXT REFERENCES recordings (id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

-- suggestions
CREATE TABLE suggestions (
    id               TEXT PRIMARY KEY,
    type             TEXT NOT NULL CHECK (type IN (
                         'restaurant_booking',
                         'follow_up',
                         'transport_check'
                     )),
    calendar_event_id TEXT REFERENCES calendar_events (id) ON DELETE CASCADE,
    payload          TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'accepted', 'dismissed')),
    created_at       TEXT NOT NULL
);
CREATE INDEX idx_suggestions_status ON suggestions (status);
CREATE INDEX idx_suggestions_event ON suggestions (calendar_event_id);

-- phone_calls
CREATE TABLE phone_calls (
    id               TEXT PRIMARY KEY,
    suggestion_id    TEXT NOT NULL REFERENCES suggestions (id) ON DELETE CASCADE,
    provider         TEXT NOT NULL CHECK (provider IN ('vapi', 'bland')),
    external_call_id TEXT,
    phone_number     TEXT NOT NULL,
    party_size       INTEGER NOT NULL,
    requested_time   TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
    result_summary   TEXT,
    called_at        TEXT,
    completed_at     TEXT
);
CREATE INDEX idx_phone_calls_status ON phone_calls (status);

-- config
CREATE TABLE config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES
    ('whisper_model',                'small'),
    ('recording_source',             'mic_only'),
    ('calendar_sync_interval_min',   '15'),
    ('language_hint',                'auto'),
    ('launch_at_login',              'false'),
    ('weekly_synthesis',             ''),
    ('weekly_synthesis_last_run',    ''),
    ('vapi_phone_number_id',         '');
