-- spec/03 "Import de fichier audio" : autoriser source='import' pour un WAV
-- amené de l'extérieur (pas capturé par le recorder live). SQLite ne sait pas
-- modifier un CHECK en place → on reconstruit la table `recordings`.
--
-- `foreign_keys` est ON (db/mod.rs) et le pragma ne peut pas être basculé dans la
-- transaction qui enveloppe chaque migration sqlx. On ne peut donc pas juste
-- droper/recréer : `ALTER TABLE recordings RENAME` réécrit automatiquement la FK
-- de `transcriptions` (elle pointerait alors sur une table disparue), et un DROP
-- de la table référencée cascaderait les transcriptions. On reconstruit donc les
-- deux tables, puis on re-pointe la FK de `transcriptions` vers la nouvelle
-- `recordings` avant de supprimer les anciennes — aucune cascade ne se déclenche.

-- 1. Nouvelle table recordings (CHECK élargi à 'import'). Le RENAME fait pointer
--    temporairement la FK de transcriptions vers recordings_old.
ALTER TABLE recordings RENAME TO recordings_old;

CREATE TABLE recordings (
    id          TEXT PRIMARY KEY,
    file_path   TEXT NOT NULL,
    duration_seconds INTEGER,
    recorded_at TEXT NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('mic_only', 'system_only', 'mixed', 'import')),
    status      TEXT NOT NULL DEFAULT 'recording'
                    CHECK (status IN ('recording', 'processing', 'done', 'failed'))
);

INSERT INTO recordings (id, file_path, duration_seconds, recorded_at, source, status)
SELECT id, file_path, duration_seconds, recorded_at, source, status FROM recordings_old;

-- 2. Reconstruire transcriptions pour que sa FK cible la nouvelle `recordings`.
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

-- 3. Supprimer les anciennes tables. transcriptions_old n'a pas d'enfant ;
--    recordings_old n'est plus référencée → aucune cascade. L'index legacy part
--    avec transcriptions_old, on le recrée ensuite (mêmes noms, pas de collision).
DROP TABLE transcriptions_old;
DROP TABLE recordings_old;

CREATE INDEX idx_transcriptions_recording ON transcriptions (recording_id);
