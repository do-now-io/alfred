-- Switch default Whisper model to large-v3 for better accuracy
-- Only updates if the user hasn't changed it from the original default (small)
UPDATE config SET value = 'large-v3' WHERE key = 'whisper_model' AND value = 'small';
