-- Revert default Whisper model back to small
UPDATE config SET value = 'small' WHERE key = 'whisper_model';
