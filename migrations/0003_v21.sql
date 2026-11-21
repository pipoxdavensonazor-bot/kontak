ALTER TABLE messages ADD COLUMN client_id TEXT DEFAULT '';
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_client ON messages(conv_id, client_id) WHERE client_id != '';
