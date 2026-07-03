-- The Apple (macOS Calendar) source has been removed: Alfred now syncs only the
-- connected account's calendar (Google now; Microsoft in a later phase). Drop any
-- previously-synced Apple events so stale entries don't linger in the UI.
-- (Suggestions tied to these events cascade-delete via their FK, which is the
-- desired behaviour since the underlying events are going away.)
--
-- Note: the `source` CHECK constraint still allows 'apple'; relaxing it to add
-- 'microsoft' is deferred to the Microsoft phase to avoid a foreign-key table
-- rebuild here.
DELETE FROM calendar_events WHERE source = 'apple';
