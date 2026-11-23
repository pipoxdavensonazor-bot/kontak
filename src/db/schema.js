import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  phone: text("phone").notNull().unique(),
  salt: text("salt").notNull(),
  hash: text("hash").notNull(),
  createdAt: integer("created_at"),
  photo: text("photo").default(""),
});

export const conversations = sqliteTable("conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userA: integer("user_a").notNull(),
  userB: integer("user_b").notNull(),
  lastAt: integer("last_at").default(0),
  lastBody: text("last_body").default(""),
  title: text("title").default(""),
  isGroup: integer("is_group").default(0),
});

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  convId: integer("conv_id").notNull(),
  fromId: integer("from_id").notNull(),
  body: text("body").notNull(),
  at: integer("at").notNull(),
  readAt: integer("read_at").default(0),
  clientId: text("client_id").default(""),
});

export const members = sqliteTable("members", {
  convId: integer("conv_id").notNull(),
  userId: integer("user_id").notNull(),
});

export const sessions = sqliteTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: integer("user_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const pushSubs = sqliteTable("push_subs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
});

export const calls = sqliteTable("calls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  peerId: integer("peer_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  at: integer("at").notNull(),
});

export const media = sqliteTable("media", {
  id: text("id").primaryKey(),
  convId: integer("conv_id").notNull(),
  ownerId: integer("owner_id").notNull(),
  messageId: integer("message_id"),
  kind: text("kind").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  durationMs: integer("duration_ms").default(0),
  r2Key: text("r2_key").notNull(),
  createdAt: integer("created_at").notNull(),
});
