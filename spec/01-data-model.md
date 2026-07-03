# spec/01 — Data Model

Schéma SQLite complet. Source de vérité pour tous les autres specs.

Toutes les colonnes `id` sont des UUID v4 (TEXT). Les colonnes `*_at` sont des timestamps ISO 8601 stockés en TEXT (ex: `2026-06-09T08:30:00+02:00`).

---

## Migration 001_initial.sql

```sql
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
    attendees   TEXT,          -- JSON array of strings (emails / names)
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
    raw_text        TEXT NOT NULL,       -- texte brut concaténé
    segments_json   TEXT NOT NULL,       -- JSON array [{start, end, text}]
    language        TEXT,                -- code ISO détecté (fr, en, ...)
    whisper_model   TEXT NOT NULL,       -- small / medium / ...
    processed_at    TEXT NOT NULL
);
CREATE INDEX idx_transcriptions_recording ON transcriptions (recording_id);

-- todos
CREATE TABLE todos (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT,
    source      TEXT NOT NULL CHECK (source IN ('transcription', 'suggestion', 'manual')),
    source_id   TEXT,                   -- FK vers transcription ou suggestion (nullable)
    status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'done', 'dismissed')),
    due_date    TEXT,                   -- DATE string YYYY-MM-DD (nullable)
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX idx_todos_status ON todos (status);
CREATE INDEX idx_todos_due_date ON todos (due_date);

-- notes
CREATE TABLE notes (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL DEFAULT '',  -- Markdown
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
    payload          TEXT NOT NULL,     -- JSON, structure dépend du type
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
    external_call_id TEXT,              -- ID côté Vapi/Bland, rempli après initiation
    phone_number     TEXT NOT NULL,
    party_size       INTEGER NOT NULL,
    requested_time   TEXT NOT NULL,     -- ex: "20:00" ou "lunch"
    status           TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
    result_summary   TEXT,              -- résumé de l'appel, rempli en fin d'appel
    called_at        TEXT,
    completed_at     TEXT
);
CREATE INDEX idx_phone_calls_status ON phone_calls (status);

-- config (settings utilisateur non-secrets)
CREATE TABLE config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Valeurs par défaut de la config
INSERT INTO config (key, value) VALUES
    ('whisper_model',        'small'),
    ('recording_source',     'mic_only'),
    ('calendar_sync_interval_min', '15'),
    ('language_hint',        'auto'),
    ('launch_at_login',      'false'),
    ('weekly_synthesis_last_run', '');
```

---

## Payloads JSON par type de suggestion

### `restaurant_booking`
```json
{
  "restaurant_name": "Le Comptoir",
  "phone_number": "+33 1 42 00 00 00",
  "address": "12 rue de Rivoli, Paris",
  "google_place_id": "ChIJ...",
  "reason": "Client lunch detected — no location set on event"
}
```

### `follow_up`
```json
{
  "contact_name": "Jean Dupont",
  "reason": "Mentioned in transcription — 'il faudra rappeler Jean'"
}
```

### `transport_check`
```json
{
  "destination": "Lyon",
  "event_date": "2026-06-15",
  "reason": "Event contains 'voyage Lyon' — no transport todo found"
}
```

---

## Convention de migration

- Fichiers dans `src-tauri/migrations/`
- Nommage : `NNN_description.sql` (NNN = 3 chiffres, ex: `002_add_voice_notes.sql`)
- Migrations **additives uniquement** pour v1 — aucun `DROP TABLE` / `DROP COLUMN`
- Chaque migration est appliquée une seule fois par `sqlx::migrate!` au démarrage

---

## Règles de soft delete

Aucune ligne n'est jamais supprimée en dur, sauf :
- Les fichiers WAV (`recordings.file_path`) après transcription confirmée — le record `recordings` reste
- Les `calendar_events` obsolètes (non retournés par l'API après une sync complète) — suppression douce via `status` à ajouter en migration future si besoin

Les `todos` et `suggestions` dismissés restent en DB avec `status = dismissed`.
