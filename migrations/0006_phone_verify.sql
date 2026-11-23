-- v25: optional SMS verification of the account phone number.
-- Codes are hashed in phone_otps; users.phone_verified_at is set on success.
-- Tables/indexes are IF NOT EXISTS. The extra column is applied once via d1_migrations.
ALTER TABLE users ADD COLUMN phone_verified_at INTEGER;

CREATE TABLE IF NOT EXISTS phone_otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_phone_otps_phone_created ON phone_otps(phone, created_at);
CREATE INDEX IF NOT EXISTS idx_phone_otps_user ON phone_otps(user_id, created_at);
