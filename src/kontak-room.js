import { DurableObject } from "cloudflare:workers";
import { getDb, schema, eq, and, or, like, desc, lt } from "./db/index.js";
import { RegisterSchema, LoginSchema, SearchSchema, SendMessageSchema, GetMessagesSchema, GetOrCreateSchema, CallSchema, validate } from "./validation.js";

export class KontakRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.online = new Map();
    this.wsUser = new Map();
    this.db = getDb(env.DB);
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch {
      this.send(ws, { type: "error", error: "bad-json" });
      return;
    }

    try {
      switch (msg.type) {
        case "register": return await this.handleRegister(ws, msg);
        case "login": return await this.handleLogin(ws, msg);
        case "search": return await this.handleSearch(ws, msg);
        case "getConversations": return await this.handleGetConversations(ws);
        case "getOrCreateConversation": return await this.handleGetOrCreate(ws, msg);
        case "getMessages": return await this.handleGetMessages(ws, msg);
        case "sendMessage": return await this.handleSendMessage(ws, msg);
        case "typing": return this.handleTyping(ws, msg);
        case "callOffer":
        case "callAnswer":
        case "callIce":
        case "callDecline":
        case "callHangup":
          return await this.relayCall(ws, msg);
        default:
          this.send(ws, { type: "error", error: "unknown-type" });
      }
    } catch (e) {
      console.error("Handler error:", e);
      this.send(ws, { type: "error", error: e.message || "server-error" });
    }
  }

  async webSocketClose(ws) {
    const userId = this.wsUser.get(ws);
    if (userId) {
      const set = this.online.get(userId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) this.online.delete(userId);
      }
      this.wsUser.delete(ws);
      this.broadcastPresence(userId, false);
    }
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcastToUser(userId, obj) {
    const set = this.online.get(userId);
    if (!set) return;
    for (const w of set) this.send(w, obj);
  }

  addOnline(userId, ws) {
    if (!this.online.has(userId)) this.online.set(userId, new Set());
    this.online.get(userId).add(ws);
    this.wsUser.set(ws, userId);
  }

  getUserId(ws) { return this.wsUser.get(ws); }

  async broadcastPresence(userId, isOnline) {
    try {
      const convs = await this.db.select().from(schema.conversations)
        .where(or(eq(schema.conversations.userA, userId), eq(schema.conversations.userB, userId)));
      for (const c of convs) {
        const peer = c.userA === userId ? c.userB : c.userA;
        this.broadcastToUser(peer, { type: "presence", userId, online: isOnline });
      }
    } catch {}
  }

  async hashPass(password, salt) {
    const data = new TextEncoder().encode(salt + password);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async handleRegister(ws, msg) {
    const data = validate(RegisterSchema, msg);
    const phone = data.phone.replace(/\D/g, "");
    const name = data.name.trim().slice(0, 40);
    const password = data.password;

    const existing = await this.db.select().from(schema.users).where(eq(schema.users.phone, phone)).get();
    if (existing) throw new Error("phone-taken");

    const salt = crypto.randomUUID().replace(/-/g, "");
    const hash = await this.hashPass(password, salt);
    const res = await this.db.insert(schema.users).values({ name, phone, salt, hash }).returning();

    const me = { id: res[0].id, name, phone };
    this.addOnline(me.id, ws);
    this.send(ws, { type: "auth-ok", user: me });
    await this.broadcastPresence(me.id, true);
  }

  async handleLogin(ws, msg) {
    const data = validate(LoginSchema, msg);
    const phone = data.phone.replace(/\D/g, "");
    const password = data.password;
    const user = await this.db.select().from(schema.users).where(eq(schema.users.phone, phone)).get();
    if (!user) throw new Error("bad-creds");
    const hash = await this.hashPass(password, user.salt);
    if (hash !== user.hash) throw new Error("bad-creds");

    const me = { id: user.id, name: user.name, phone: user.phone };
    this.addOnline(me.id, ws);
    this.send(ws, { type: "auth-ok", user: me });
    await this.broadcastPresence(me.id, true);
  }

  async handleSearch(ws, msg) {
    const meId = this.getUserId(ws);
    if (!meId) return;
    const q = `%${String(msg.q || "").toLowerCase()}%`;
    const results = await this.db.select({ id: schema.users.id, name: schema.users.name, phone: schema.users.phone })
      .from(schema.users)
      .limit(20);
    const list = results.filter(u => u.id !== meId &&
      (u.name.toLowerCase().includes(msg.q?.toLowerCase() || "") || u.phone.includes(msg.q || "")))
      .map(u => ({ ...u, online: this.online.has(u.id) && this.online.get(u.id).size > 0 }));
    this.send(ws, { type: "search-results", results: list });
  }

  async handleGetConversations(ws) {
    const meId = this.getUserId(ws);
    if (!meId) return;
    const convs = await this.db.select().from(schema.conversations)
      .where(or(eq(schema.conversations.userA, meId), eq(schema.conversations.userB, meId)))
      .orderBy(desc(schema.conversations.lastAt));

    const list = [];
    for (const c of convs) {
      const peerId = c.userA === meId ? c.userB : c.userA;
      const peer = await this.db.select().from(schema.users).where(eq(schema.users.id, peerId)).get();
      list.push({
        id: c.id,
        peer: peer ? { id: peer.id, name: peer.name, phone: peer.phone, online: this.online.has(peer.id) && this.online.get(peer.id).size > 0 } : { id: peerId, name: "?", phone: "", online: false },
        lastAt: c.lastAt,
        lastBody: c.lastBody
      });
    }
    this.send(ws, { type: "conversations", list });
  }

  async handleGetOrCreate(ws, msg) {
    const meId = this.getUserId(ws);
    if (!meId) return;
    const peerId = Number(msg.peerId);
    const peer = await this.db.select().from(schema.users).where(eq(schema.users.id, peerId)).get();
    if (!peer) throw new Error("no-peer");

    const lo = Math.min(meId, peerId), hi = Math.max(meId, peerId);
    let conv = await this.db.select().from(schema.conversations)
      .where(or(
        and(eq(schema.conversations.userA, lo), eq(schema.conversations.userB, hi)),
        and(eq(schema.conversations.userA, hi), eq(schema.conversations.userB, lo))
      )).get();

    if (!conv) {
      const res = await this.db.insert(schema.conversations).values({ userA: lo, userB: hi }).returning();
      conv = res[0];
    }
    this.send(ws, { type: "conversation", id: conv.id });
  }

  async handleGetMessages(ws, msg) {
    const meId = this.getUserId(ws);
    if (!meId) return;
    const convId = Number(msg.convId);
    const before = Number(msg.beforeId) || 1e15;
    const limit = Math.min(50, Number(msg.limit) || 30);

    const conv = await this.db.select().from(schema.conversations).where(eq(schema.conversations.id, convId)).get();
    if (!conv || (conv.userA !== meId && conv.userB !== meId)) throw new Error("no-conv");

    const results = await this.db.select({
      id: schema.messages.id,
      from: schema.messages.fromId,
      body: schema.messages.body,
      at: schema.messages.at
    }).from(schema.messages)
      .where(and(eq(schema.messages.convId, convId), lt(schema.messages.id, before)))
      .orderBy(desc(schema.messages.id))
      .limit(limit);

    const messages = results.reverse();
    this.send(ws, { type: "messages", convId, messages, hasMore: messages.length === limit });
  }

  async handleSendMessage(ws, msg) {
    const meId = this.getUserId(ws);
    if (!meId) return;
    const convId = Number(msg.convId);
    const body = String(msg.body || "").slice(0, 2000);
    if (!body) throw new Error("empty");

    const conv = await this.db.select().from(schema.conversations).where(eq(schema.conversations.id, convId)).get();
    if (!conv || (conv.userA !== meId && conv.userB !== meId)) throw new Error("no-conv");

    const at = Date.now();
    const res = await this.db.insert(schema.messages).values({ convId, fromId: meId, body, at }).returning();

    await this.db.update(schema.conversations)
      .set({ lastAt: at, lastBody: body.slice(0, 80) })
      .where(eq(schema.conversations.id, convId));

    const m = { id: res[0].id, convId, from: meId, body, at };
    const payload = { type: "new-message", message: m, convId };
    this.send(ws, payload);

    const peerId = conv.userA === meId ? conv.userB : conv.userA;
    this.broadcastToUser(peerId, payload);
  }

  async handleTyping(ws, msg) {
    const meId = this.getUserId(ws);
    if (!meId) return;
    const convId = Number(msg.convId);
    if (!convId) return;
    const conv = await this.db.select().from(schema.conversations).where(eq(schema.conversations.id, convId)).get();
    if (!conv || (conv.userA !== meId && conv.userB !== meId)) return;
    const peerId = conv.userA === meId ? conv.userB : conv.userA;
    const me = await this.db.select().from(schema.users).where(eq(schema.users.id, meId)).get();
    this.broadcastToUser(peerId, { type: "typing", convId, from: meId, fromName: me ? me.name : "?" });
  }

  async relayCall(ws, msg) {
    const meId = this.getUserId(ws);
    if (!meId) return;

    let peerId = Number(msg.peerId);
    if (!peerId && msg.convId) {
      const conv = await this.db.select().from(schema.conversations).where(eq(schema.conversations.id, Number(msg.convId))).get();
      if (conv) peerId = conv.userA === meId ? conv.userB : conv.userA;
    }
    if (peerId && peerId !== meId) {
      this.broadcastToUser(peerId, { ...msg, from: meId });
    }
  }
}
