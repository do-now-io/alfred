-- spec/06: the vault's Todo.md is the todos source of truth — the SQLite table
-- is abandoned. No data migration (no production users; the merged ingestion
-- had been dual-writing to Todo.md since it landed anyway).

DROP TABLE IF EXISTS todos;
