-- v24: voice notes and photos. Media bytes live in R2 (binding MEDIA); this table
-- holds metadata and the link to the message. Idempotent (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  conv_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  message_id INTEGER,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  duration_ms INTEGER DEFAULT 0,
  r2_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_message ON media(message_id);
CREATE INDEX IF NOT EXISTS idx_media_conv ON media(conv_id);
