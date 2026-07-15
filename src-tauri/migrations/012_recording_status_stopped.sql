-- spec/03 « arrêt interruptible » : « Terminer » ne lance plus l'aval mais passe
-- la prise en revue → nouvel état 'stopped' (panneau Supprimer / Continuer).
-- SQLite ne sait pas modifier un CHECK en place → reconstruction de `recordings`
-- (même danse FK que la migration 009 : on reconstruit aussi `transcriptions`
-- pour re-pointer sa FK sans déclencher de cascade).

ALTER TABLE recordings RENAME TO recordings_old;

CREATE TABLE recordings (
    id          TEXT PRIMARY KEY,
    file_path   TEXT NOT NULL,
    duration_seconds INTEGER,
    recorded_at TEXT NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('mic_only', 'system_only', 'mixed', 'import')),
    status      TEXT NOT NULL DEFAULT 'recording'
                    CHECK (status IN ('recording', 'stopped', 'processing', 'done', 'failed')),
    purpose     TEXT NOT NULL DEFAULT 'meeting'
);

INSERT INTO recordings (id, file_path, duration_seconds, recorded_at, source, status, purpose)
SELECT id, file_path, duration_seconds, recorded_at, source, status, purpose FROM recordings_old;

ALTER TABLE transcriptions RENAME TO transcriptions_old;

CREATE TABLE transcriptions (
    id              TEXT PRIMARY KEY,
    recording_id    TEXT NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
    raw_text        TEXT NOT NULL,
    segments_json   TEXT NOT NULL,
    language        TEXT,
    whisper_model   TEXT NOT NULL,
    processed_at    TEXT NOT NULL
);

INSERT INTO transcriptions (id, recording_id, raw_text, segments_json, language, whisper_model, processed_at)
SELECT id, recording_id, raw_text, segments_json, language, whisper_model, processed_at FROM transcriptions_old;

DROP TABLE transcriptions_old;
DROP TABLE recordings_old;

CREATE INDEX idx_transcriptions_recording ON transcriptions (recording_id);
