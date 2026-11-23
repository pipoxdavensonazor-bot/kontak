-- v26: optional email verification. Codes are hashed in email_otps;
-- users.email and users.email_verified_at are set on success.
-- Tables/indexes are IF NOT EXISTS. Extra columns are applied once via d1_migrations.
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL AND email != '';

CREATE TABLE IF NOT EXISTS email_otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  ip TEXT,
  sender TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_otps_email_created ON email_otps(email, created_at);
CREATE INDEX IF NOT EXISTS idx_email_otps_user ON email_otps(user_id, created_at);
