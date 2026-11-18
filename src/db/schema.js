import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  phone: text("phone").notNull().unique(),
  salt: text("salt").notNull(),
  hash: text("hash").notNull(),
  createdAt: integer("created_at"),
});

export const conversations = sqliteTable("conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userA: integer("user_a").notNull(),
  userB: integer("user_b").notNull(),
  lastAt: integer("last_at").default(0),
  lastBody: text("last_body").default(""),
});

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  convId: integer("conv_id").notNull(),
  fromId: integer("from_id").notNull(),
  body: text("body").notNull(),
  at: integer("at").notNull(),
});
