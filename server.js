const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, ".")));

// === SQLite ===
const db = new Database(path.join(__dirname, "kontak.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a INTEGER NOT NULL,
    user_b INTEGER NOT NULL,
    last_at INTEGER DEFAULT 0,
    last_body TEXT DEFAULT '',
    UNIQUE(user_a, user_b)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conv_id INTEGER NOT NULL,
    from_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, id);
  CREATE INDEX IF NOT EXISTS idx_conv_users ON conversations(user_a, user_b);
`);

// ... (rest of server.js - truncated for this example, full content will be pushed)
