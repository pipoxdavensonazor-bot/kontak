-- v23: tables that were only created at runtime (KontakRoom.ensureSchema).
-- They already exist in production, so everything here is IF NOT EXISTS / no-op there.
-- Runtime columns (users.photo, conversations.title/is_group, messages.read_at/client_id)
-- and the sessions table are already covered by 0002 and 0003.
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  peer_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  at INTEGER NOT NULL
);
