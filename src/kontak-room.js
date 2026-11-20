import { DurableObject } from "cloudflare:workers";
import { getDb, schema, eq, and, or, desc, lt } from "./db/index.js";
import { RegisterSchema, LoginSchema, validate } from "./validation.js";

export class KontakRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.online = new Map();
    this.wsUser = new Map();
    this.busy = new Map();
    this.db = getDb(env.DB);
    try {
      for (const sock of ctx.getWebSockets()) {
        const att = sock.deserializeAttachment();
        if (att && att.userId) {
          this.track(att.userId, sock);
          if (att.busyWith) this.busy.set(att.userId, att.busyWith);
        }
      }
    } catch (e) {
      console.error("restore ws", e);
    }
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
      await this.ensureSchema();
      switch (msg.type) {
        case "register": return await this.handleRegister(ws, msg);
        case "login": return await this.handleLogin(ws, msg);
        case "search": return await this.handleSearch(ws, msg);
        case "getConversations": return await this.handleGetConversations(ws);
        case "getOrCreateConversation": return await this.handleGetOrCreate(ws, msg);
        case "getMessages": return await this.handleGetMessages(ws, msg);
        case "sendMessage": return await this.handleSendMessage(ws, msg);
        case "setProfile": return await this.handleSetProfile(ws, msg);
        case "createGroup": return await this.handleCreateGroup(ws, msg);
        case "markRead": return await this.handleMarkRead(ws, msg);
        case "typing": return await this.handleTyping(ws, msg);
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
      const peer = this.busy.get(userId);
      if (!this.online.has(userId)) {
        this.busy.delete(userId);
        if (peer) {
          this.busy.delete(peer);
          this.broadcastToUser(peer, { type: "callHangup", from: userId });
        }
      }
      this.broadcastPresence(userId, false);
    }
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

  broadcastToUser(userId, obj) {
    const set = this.online.get(userId);
    if (!set) return;
    for (const w of set) this.send(w, obj);
  }

  track(userId, ws) {
    if (!this.online.has(userId)) this.online.set(userId, new Set());
    this.online.get(userId).add(ws);
    this.wsUser.set(ws, userId);
  }

  addOnline(userId, ws) {
    this.track(userId, ws);
    try { ws.serializeAttachment({ userId }); } catch {}
  }

  needUser(ws) {
    let id = this.wsUser.get(ws);
    if (!id) {
      try {
        const att = ws.deserializeAttachment();
        if (att && att.userId) {
          this.track(att.userId, ws);
          id = att.userId;
        }
      } catch {}
    }
    if (!id) throw new Error("not-auth");
    return id;
  }

  isOnline(userId) {
    const set = this.online.get(userId);
    return !!(set && set.size > 0);
  }

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

  async ensureSchema() {
    if (!this._schema) {
      this._schema = (async () => {
        const sqls = [
          "ALTER TABLE users ADD COLUMN photo TEXT DEFAULT ''",
          "ALTER TABLE conversations ADD COLUMN title TEXT DEFAULT ''",
          "ALTER TABLE conversations ADD COLUMN is_group INTEGER DEFAULT 0",
          "ALTER TABLE messages ADD COLUMN read_at INTEGER DEFAULT 0",
          "CREATE TABLE IF NOT EXISTS members (conv_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (conv_id, user_id))"
        ];
        for (const sql of sqls) {
          try { await this.env.DB.prepare(sql).run(); } catch {}
        }
      })();
    }
    return this._schema;
  }

  pub(user) {
    if (!user) return null;
    return {
      id: user.id,
      name: user.name,
      phone: user.phone,
      photo: user.photo || "",
      online: this.isOnline(user.id)
    };
  }

  async memberIds(conv) {
    if (!conv || !conv.isGroup) return [conv.userA, conv.userB].filter((id) => id > 0);
    const rows = await this.db.select().from(schema.members).where(eq(schema.members.convId, conv.id));
    const ids = rows.map((r) => r.userId);
    if (!ids.includes(conv.userA)) ids.push(conv.userA);
    return ids;
  }

  async inConv(conv, meId) {
    if (!conv) return false;
    if (conv.isGroup) return (await this.memberIds(conv)).includes(meId);
    return conv.userA === meId || conv.userB === meId;
  }

  async others(conv, meId) {
    return (await this.memberIds(conv)).filter((id) => id !== meId && id > 0);
  }

  async markRead(meId, convId) {
    const at = Date.now();
    await this.env.DB.prepare(
      "UPDATE messages SET read_at = ? WHERE conv_id = ? AND from_id != ? AND (read_at IS NULL OR read_at = 0)"
    ).bind(at, convId, meId).run();
    const conv = await this.db.select().from(schema.conversations).where(eq(schema.conversations.id, convId)).get();
    if (!conv) return;
    for (const id of await this.others(conv, meId)) {
      this.broadcastToUser(id, { type: "messages-read", convId, by: meId, at });
    }
  }

  async convsFor(meId) {
    const direct = await this.db.select().from(schema.conversations)
      .where(or(eq(schema.conversations.userA, meId), eq(schema.conversations.userB, meId)));
    const map = new Map(direct.map((c) => [c.id, c]));
    const mem = await this.db.select().from(schema.members).where(eq(schema.members.userId, meId));
    for (const m of mem) {
      if (map.has(m.convId)) continue;
      const c = await this.db.select().from(schema.conversations).where(eq(schema.conversations.id, m.convId)).get();
      if (c) map.set(c.id, c);
    }
    return [...map.values()].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  }

  async summarize(c, meId) {
    const last = await this.db.select().from(schema.messages)
      .where(eq(schema.messages.convId, c.id))
      .orderBy(desc(schema.messages.id))
      .limit(1)
      .get();
    const seen = !!(last && last.fromId === meId && last.readAt);
    if (c.isGroup) {
      const ids = await this.memberIds(c);
      return {
        id: c.id,
        isGroup: true,
        peer: {
          id: 0,
          name: c.title || "Gwoup",
          phone: ids.length + " moun",
          online: ids.some((id) => id !== meId && this.isOnline(id)),
          photo: "",
          isGroup: true
        },
        lastAt: c.lastAt,
        lastBody: c.lastBody,
        seen
      };
    }
    const peerId = c.userA === meId ? c.userB : c.userA;
    const peer = await this.db.select().from(schema.users).where(eq(schema.users.id, peerId)).get();
    return {
      id: c.id,
      isGroup: false,
      peer: peer ? this.pub(peer) : { id: peerId, name: "?", phone: "", online: false, photo: "" },
      lastAt: c.lastAt,
      lastBody: c.lastBody,
      seen
    };
  }

  async hashPass(password, salt) {
    const data = new TextEncoder().encode(salt + password);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async handleRegister(ws, msg) {
    const data = validate(RegisterSchema, msg);
    const phone = data.phone;
    const name = data.name.trim().slice(0, 40);
    const password = data.password;

    const existing = await this.db.select().from(schema.users).where(eq(schema.users.phone, phone)).get();
    if (existing) throw new Error("phone-taken");

    const salt = crypto.randomUUID().replace(/-/g, "");
    const hash = await this.hashPass(password, salt);
    const res = await this.db.insert(schema.users).values({ name, phone, salt, hash, createdAt: Date.now() }).returning();

    const me = { id: res[0].id, name, phone, photo: "" };
    this.addOnline(me.id, ws);
    this.send(ws, { type: "auth-ok", user: me });
    await this.broadcastPresence(me.id, true);
  }

  async handleLogin(ws, msg) {
    const data = validate(LoginSchema, msg);
    const user = await this.db.select().from(schema.users).where(eq(schema.users.phone, data.phone)).get();
    if (!user) throw new Error("bad-creds");
    const hash = await this.hashPass(data.password, user.salt);
    if (hash !== user.hash) throw new Error("bad-creds");

    const me = { id: user.id, name: user.name, phone: user.phone, photo: user.photo || "" };
    this.addOnline(me.id, ws);
    this.send(ws, { type: "auth-ok", user: me });
    await this.broadcastPresence(me.id, true);
  }

  async handleSearch(ws, msg) {
    const meId = this.needUser(ws);
    const raw = String(msg.q || "").trim();
    const q = raw.toLowerCase();
    const qd = raw.replace(/\D/g, "");
    if (q.length < 1) return this.send(ws, { type: "search-results", results: [] });
    const results = await this.db.select({ id: schema.users.id, name: schema.users.name, phone: schema.users.phone })
      .from(schema.users)
      .limit(50);
    const picked = results.filter((u) => u.id !== meId && (
      (u.name || "").toLowerCase().includes(q) || (qd.length >= 3 && (u.phone || "").includes(qd))
    )).slice(0, 12);
    const list = [];
    for (const u of picked) {
      const full = await this.db.select().from(schema.users).where(eq(schema.users.id, u.id)).get();
      list.push(this.pub(full));
    }
    this.send(ws, { type: "search-results", results: list });
  }

  async handleGetConversations(ws) {
    const meId = this.needUser(ws);
    const convs = await this.convsFor(meId);
    const list = [];
    for (const c of convs) list.push(await this.summarize(c, meId));
    this.send(ws, { type: "conversations", list });
  }

  async handleGetOrCreate(ws, msg) {
    const meId = this.needUser(ws);
    const peerId = Number(msg.peerId);
    if (!peerId || peerId === meId) throw new Error("no-peer");
    const peer = await this.db.select().from(schema.users).where(eq(schema.users.id, peerId)).get();
    if (!peer) throw new Error("no-peer");

    const lo = Math.min(meId, peerId);
    const hi = Math.max(meId, peerId);
    let conv = await this.db.select().from(schema.conversations)
      .where(and(eq(schema.conversations.userA, lo), eq(schema.conversations.userB, hi))).get();

    if (!conv) {
      const res = await this.db.insert(schema.conversations).values({ userA: lo, userB: hi }).returning();
      conv = res[0];
    }
    this.send(ws, { type: "conversation", id: conv.id, peer: this.pub(peer) });
  }

  async handleGetMessages(ws, msg) {
    const meId = this.needUser(ws);
    const convId = Number(msg.convId);
    const before = Number(msg.beforeId) || 1e15;
    const limit = Math.min(50, Number(msg.limit) || 30);

    const conv = await this.db.select().from(schema.conversations).where(eq(schema.conversations.id, convId)).get();
    if (!(await this.inConv(conv, meId))) throw new Error("no-conv");

    const results = await this.db.select({
      id: schema.messages.id,
      from: schema.messages.fromId,
      body: schema.messages.body,
      at: schema.messages.at,
      readAt: schema.messages.readAt
    }).from(schema.messages)
      .where(and(eq(schema.messages.convId, convId), lt(schema.messages.id, before)))
      .orderBy(desc(schema.messages.id))
      .limit(limit);

    await this.markRead(meId, convId);
    this.send(ws, { type: "messages", convId, messages: results.reverse(), hasMore: results.length === limit });
  }

  async handleSendMessage(ws, msg) {
    const meId = this.needUser(ws);
    const convId = Number(msg.convId);
    const body = String(msg.body || "").slice(0, 2000);
    if (!body.trim()) throw new Error("empty");

    const conv = await this.db.select().from(schema.conversations).where(eq(schema.conversations.id, convId)).get();
    if (!(await this.inConv(conv, meId))) throw new Error("no-conv");

    const at = Date.now();
    const res = await this.db.insert(schema.messages).values({ convId, fromId: meId, body, at, readAt: 0 }).returning();
    await this.db.update(schema.conversations)
      .set({ lastAt: at, lastBody: body.slice(0, 80) })
      .where(eq(schema.conversations.id, convId));

    const payload = {
      type: "new-message",
      convId,
      message: { id: res[0].id, convId, from: meId, body, at, readAt: 0 }
    };
    this.send(ws, payload);
    for (const id of await this.others(conv, meId)) this.broadcastToUser(id, payload);
  }

  async handleSetProfile(ws, msg) {
    const meId = this.needUser(ws);
    const photo = String(msg.photo || "");
    if (photo && (!photo.startsWith("data:image/") || photo.length > 80000)) throw new Error("photo-big");
    const name = String(msg.name || "").trim().slice(0, 40);
    const patch = { photo };
    if (name) patch.name = name;
    await this.db.update(schema.users).set(patch).where(eq(schema.users.id, meId));
    const user = await this.db.select().from(schema.users).where(eq(schema.users.id, meId)).get();
    this.send(ws, { type: "profile-ok", user: this.pub(user) });
  }

  async handleCreateGroup(ws, msg) {
    const meId = this.needUser(ws);
    const title = String(msg.title || "Gwoup").trim().slice(0, 40) || "Gwoup";
    const raw = Array.isArray(msg.phones) ? msg.phones.join(",") : String(msg.phones || "");
    const ids = new Set([meId]);
    for (const part of raw.split(/[\s,;]+/)) {
      const phone = part.replace(/\D/g, "");
      if (phone.length < 8) continue;
      const u = await this.db.select().from(schema.users).where(eq(schema.users.phone, phone)).get();
      if (u) ids.add(u.id);
    }
    if (ids.size < 2) throw new Error("group-need-people");
    const res = await this.db.insert(schema.conversations).values({
      userA: meId,
      userB: -Date.now(),
      title,
      isGroup: 1,
      lastAt: Date.now(),
      lastBody: "Gwoup kreye"
    }).returning();
    const conv = res[0];
    for (const id of ids) {
      await this.db.insert(schema.members).values({ convId: conv.id, userId: id });
    }
    this.send(ws, {
      type: "conversation",
      id: conv.id,
      peer: { id: 0, name: title, phone: ids.size + " moun", online: false, photo: "", isGroup: true }
    });
    for (const id of ids) {
      if (id !== meId) this.broadcastToUser(id, { type: "conversations-refresh" });
    }
  }

  async handleMarkRead(ws, msg) {
    const meId = this.needUser(ws);
    const convId = Number(msg.convId);
    const conv = await this.db.select().from(schema.conversations).where(eq(schema.conversations.id, convId)).get();
    if (!(await this.inConv(conv, meId))) return;
    await this.markRead(meId, convId);
  }

  async handleTyping(ws, msg) {
    const meId = this.needUser(ws);
    const convId = Number(msg.convId);
    if (!convId) return;
    const conv = await this.db.select().from(schema.conversations).where(eq(schema.conversations.id, convId)).get();
    if (!(await this.inConv(conv, meId))) return;
    const me = await this.db.select().from(schema.users).where(eq(schema.users.id, meId)).get();
    for (const id of await this.others(conv, meId)) {
      this.broadcastToUser(id, { type: "typing", convId, from: meId, fromName: me ? me.name : "?" });
    }
  }

  setBusy(userId, peerId) {
    this.busy.set(userId, peerId);
    const set = this.online.get(userId);
    if (!set) return;
    for (const sock of set) {
      try { sock.serializeAttachment({ userId, busyWith: peerId }); } catch {}
    }
  }

  clearBusy(userId) {
    this.busy.delete(userId);
    const set = this.online.get(userId);
    if (!set) return;
    for (const sock of set) {
      try { sock.serializeAttachment({ userId, busyWith: null }); } catch {}
    }
  }

  async relayCall(ws, msg) {
    const meId = this.needUser(ws);
    let peerId = Number(msg.peerId);
    if (!peerId && msg.convId) {
      const conv = await this.db.select().from(schema.conversations).where(eq(schema.conversations.id, Number(msg.convId))).get();
      if (conv) peerId = conv.userA === meId ? conv.userB : conv.userA;
    }
    if (!peerId || peerId === meId) return;
    const me = await this.db.select().from(schema.users).where(eq(schema.users.id, meId)).get();
    const fromName = me ? me.name : "?";

    if (msg.type === "callOffer") {
      const peerBusy = this.busy.get(peerId);
      const meBusy = this.busy.get(meId);
      if ((peerBusy && peerBusy !== meId) || (meBusy && meBusy !== peerId)) {
        this.send(ws, { type: "callBusy", convId: msg.convId, fromName });
        return;
      }
      this.setBusy(meId, peerId);
      this.setBusy(peerId, meId);
    }
    if (msg.type === "callHangup" || msg.type === "callDecline") {
      this.clearBusy(meId);
      this.clearBusy(peerId);
    }

    this.broadcastToUser(peerId, { ...msg, from: meId, fromName });
  }
}
