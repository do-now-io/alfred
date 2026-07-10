-- spec/13/17 — « contexte à la voix ». Un enregistrement peut avoir deux buts :
-- 'meeting' (défaut, flux normal : compte-rendu + tâches) ou 'context' (visite
-- guidée : la transcription construit `Contexte Alfred.md` + le glossaire, pas de
-- compte-rendu). ADD COLUMN avec DEFAULT littéral : pas besoin de reconstruire la
-- table (contrairement à un changement de CHECK). Le but est validé côté code.
ALTER TABLE recordings ADD COLUMN purpose TEXT NOT NULL DEFAULT 'meeting';
