-- spec/18 — Partage de notes (côté app). Mémorise les partages actifs pour
-- retrouver le lien, mettre à jour (même URL) ou révoquer. `note_path` = clé
-- locale stable (chemin de la note, ou du Todo.md). `manage_token` = secret livré
-- une fois par le backend, requis pour PUT/DELETE.
CREATE TABLE note_shares (
    note_path     TEXT PRIMARY KEY,
    slug          TEXT NOT NULL,
    manage_token  TEXT NOT NULL,
    url           TEXT NOT NULL,
    created_at    TEXT NOT NULL
);
