# spec/01 — Data Model

Schéma SQLite courant (migrations `001`→`005` appliquées). Source de vérité pour
les autres specs.

Toutes les colonnes `id` sont des UUID v4 (TEXT). Les colonnes `*_at` sont des
timestamps ISO 8601 en TEXT (ex : `2026-06-09T08:30:00+02:00`). Les `due_date`
sont des dates `YYYY-MM-DD`.

> ⚠️ Les notes ne vivent **plus** en SQLite (voir spec/07 — vault de fichiers
> `.md`). La table `notes` reste en base pour la migration legacy uniquement.
> Les tables `suggestions` et `phone_calls` existent mais sont **hors v1**.

---

## Tables v1

> ⚠️ `calendar_events` est désormais **hors v1** (calendrier retiré) — laissée
> ci-dessous pour référence, mais plus alimentée.

```sql
-- calendar_events
CREATE TABLE calendar_events (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL CHECK (source IN ('google', 'apple')), -- voir note ↓
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
    whisper_model   TEXT NOT NULL,       -- small / large-v3 / ...
    processed_at    TEXT NOT NULL
);
CREATE INDEX idx_transcriptions_recording ON transcriptions (recording_id);

-- todos
CREATE TABLE todos (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT,
    source      TEXT NOT NULL CHECK (source IN ('transcription', 'suggestion', 'manual')),
    source_id   TEXT,                   -- FK logique vers transcription/suggestion (nullable)
    status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'done', 'dismissed')),
    due_date    TEXT,                   -- YYYY-MM-DD (nullable)
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX idx_todos_status ON todos (status);
CREATE INDEX idx_todos_due_date ON todos (due_date);
-- ⚠️ PAS de colonne title_hash (voir « Écarts à trancher »).

-- config (voir plus bas)
CREATE TABLE config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

### Note sur `calendar_events.source`

La contrainte `CHECK` autorise encore `'apple'` (les lignes Apple ont été
supprimées par la migration `005`, mais la contrainte n'a pas été relâchée pour
éviter un rebuild de table). L'ajout de `'microsoft'` se fera lors de la phase
Microsoft (voir spec/02).

---

## Table `notes` (legacy)

```sql
CREATE TABLE notes (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL DEFAULT '',  -- Markdown
    recording_id TEXT REFERENCES recordings (id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    migrated_at  TEXT                       -- migration 004 : exportée vers le vault
);
```

Conservée uniquement pour exporter les anciennes notes vers le vault au démarrage
(spec/07). Aucune nouvelle note n'y est écrite.

---

## Config

Clés semées par `001_initial.sql` :

| Clé | Défaut | Notes |
|---|---|---|
| `whisper_model` | `small` | `002`→`large-v3`, `003`→`small` ; net = `small` |
| `recording_source` | `mic_only` | `mic_only` / `system_only` / `mixed` |
| `calendar_sync_interval_min` | `15` | minutes |
| `language_hint` | `auto` | `auto` / `fr` / `en` / … |
| `launch_at_login` | `false` | |
| `weekly_synthesis` | `` | **texte** du dernier résumé hebdo (⚠️ le spec/05 l'appelle à tort `weekly_synthesis_text`) |
| `weekly_synthesis_last_run` | `` | date `YYYY-MM-DD` du dernier run |
| `vapi_phone_number_id` | `` | hors v1 |

Clés ajoutées à l'exécution (`INSERT OR REPLACE`) : `notes_vault_path`,
`todo_file_path` (défaut `wiki/Todo.md`), le dossier d'enregistrement, et le
prompt d'ingest (hors v1).

---

## Migrations appliquées

| # | Fichier | Effet |
|---|---|---|
| 001 | `001_initial.sql` | Schéma initial + seed config |
| 002 | `002_default_large_v3.sql` | Défaut Whisper → `large-v3` (si non modifié) |
| 003 | `003_default_small.sql` | Défaut Whisper → `small` |
| 004 | `004_add_notes_migrated_at.sql` | `notes.migrated_at` |
| 005 | `005_drop_apple_calendar.sql` | Supprime les événements `source='apple'` |

**Convention :** fichiers `NNN_description.sql`, appliqués une fois au démarrage
par `sqlx::migrate!`. **Additives uniquement** — pas de `DROP TABLE`/`DROP COLUMN`.

---

## Règles de soft delete

Aucune ligne n'est supprimée en dur, sauf :
- Les fichiers WAV (`recordings.file_path`) après transcription confirmée — le
  record `recordings` reste (voir spec/03).
- Les événements Apple obsolètes (supprimés une fois par la migration `005`).

Les `todos` `dismissed` restent en base.

---

## Décisions (résolues)

1. **Todos → vault.** La source de vérité des todos est le fichier
   `alfred-intelligence/Todo.md` (spec 06). La **table SQLite `todos` est
   abandonnée** ; la colonne `title_hash` un temps envisagée est **sans objet**.
2. **Contrainte `source`** (`calendar_events`) : le calendrier étant hors v1, le
   support `'microsoft'` (relâchement de contrainte) est reporté avec lui.

---

## Hors v1 / plus tard

Tables présentes mais non utilisées en v1 (réactivées avec Suggestions/Appels) :

```sql
-- suggestions (hors v1 — voir spec/08)
CREATE TABLE suggestions (
    id                TEXT PRIMARY KEY,
    type              TEXT NOT NULL CHECK (type IN ('restaurant_booking','follow_up','transport_check')),
    calendar_event_id TEXT REFERENCES calendar_events (id) ON DELETE CASCADE,
    payload           TEXT NOT NULL,     -- JSON, structure selon le type
    status            TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','accepted','dismissed')),
    created_at        TEXT NOT NULL
);
CREATE INDEX idx_suggestions_status ON suggestions (status);
CREATE INDEX idx_suggestions_event ON suggestions (calendar_event_id);

-- phone_calls (hors v1 — voir spec/09)
CREATE TABLE phone_calls (
    id               TEXT PRIMARY KEY,
    suggestion_id    TEXT NOT NULL REFERENCES suggestions (id) ON DELETE CASCADE,
    provider         TEXT NOT NULL CHECK (provider IN ('vapi', 'bland')),
    external_call_id TEXT,
    phone_number     TEXT NOT NULL,
    party_size       INTEGER NOT NULL,
    requested_time   TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','in_progress','completed','failed','cancelled')),
    result_summary   TEXT,
    called_at        TEXT,
    completed_at     TEXT
);
CREATE INDEX idx_phone_calls_status ON phone_calls (status);
```

Payloads JSON des suggestions (pour référence, hors v1) :

```json
// restaurant_booking
{ "restaurant_name": "...", "phone_number": "...", "address": "...", "google_place_id": "...", "reason": "..." }
// follow_up
{ "contact_name": "...", "reason": "..." }
// transport_check
{ "destination": "...", "event_date": "YYYY-MM-DD", "reason": "..." }
```
