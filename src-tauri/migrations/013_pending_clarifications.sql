-- Vérifications en attente persistantes (spec/17 §3, spec/07, feedback tests) :
-- jusqu'ici les clarifications ne vivaient que dans un event + un store front
-- volatil (`resolveStore`, une seule place) — écrasées par un 2e enregistrement,
-- perdues au redémarrage. Une ligne = une analyse déjà faite (coût Claude payé),
-- en attente du « Valider » de l'utilisateur ; supprimée à la finalisation.

CREATE TABLE pending_clarifications (
    recording_id        TEXT PRIMARY KEY REFERENCES recordings (id) ON DELETE CASCADE,
    note_title           TEXT NOT NULL,
    text                 TEXT NOT NULL,
    clarifications_json  TEXT NOT NULL,
    summary              INTEGER NOT NULL DEFAULT 1,
    tasks                INTEGER NOT NULL DEFAULT 1,
    created_at           TEXT NOT NULL
);
