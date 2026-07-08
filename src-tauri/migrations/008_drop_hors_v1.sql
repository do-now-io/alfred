-- Phase D (spec/00, spec/02, spec/08, spec/09): calendar, suggestions and
-- phone calls are out of v1 — their modules are removed from the app, drop
-- their tables. The legacy `notes` table stays (still read by the one-time
-- SQLite -> vault migration).

DROP TABLE IF EXISTS calendar_events;
DROP TABLE IF EXISTS suggestions;
DROP TABLE IF EXISTS phone_calls;
