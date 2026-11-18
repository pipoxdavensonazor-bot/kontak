import { DurableObject } from "cloudflare:workers";

export class KontakRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.online = new Map();
    this.wsUser = new Map();
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
    try { msg = JSON.parse(message); } catch { return; }
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
          return this.relayCall(ws, msg);
      }
    } catch (e) {
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
      const { results } = await this.env.DB.prepare(`
        SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS peer
        FROM conversations WHERE user_a = ? OR user_b = ?
      `).bind(userId, userId, userId).all();
      for (const r of results || []) {
        this.broadcastToUser(r.peer, { type: "presence", userId, online: isOnline });
      }
    } catch {}
  }

  async hashPass(password, salt) {
    const data = new TextEncoder().encode(salt + password);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async handleRegister(ws, msg) {
    const phone = String(msg.phone || "").replace(/\D/g, "");
    const name = String(msg.name || "").trim().slice(0, 40);
    const password = String(msg.password || "");
    if (!phone || phone.length < 6 || !name || password.length < 4) throw new Error("invalid");

    const existing = await this.env.DB.prepare("SELECT id FROM users WHERE phone = ?").bind(phone).first();
    if (existing) throw new Error("phone-taken");

    const salt = crypto.randomUUID().replace(/-/g, "");
    const hash = await this.hashPass(password, salt);
    const res = await this.env.DB.prepare(
      "INSERT INTO users (name, phone, salt, hash) VALUES (?, ?, ?, ?)"
    ).bind(name, phone, salt, hash).run();

    const me = { id: res.meta.last_row_id, name, phone };
    this.addOnline(me.id, ws);
    this.send(ws, { type: "auth-ok", user: me });
    await this.broadcastPresence(me.id, true);
  }

  async handleLogin(ws, msg) {
    const phone = String(msg.phone || "").replace(/\D/g, "");
    const password = String(msg.password || "");
    const user = await this.env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first();
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
    const { results } = await this.env.DB.prepare(`
      SELECT id, name, phone FROM users
      WHERE id != ? AND (LOWER(name) LIKE ? OR phone LIKE ?)
      LIMIT 20
    `).bind(meId, q, q).all();
    const list = (results || []).map(u => ({
      ...u,
      online: this.online.has(u.id) && this.online.get(u.id).size > 0
    }));
    this.send(ws, { type: "search-results", results: list });
  }

  async handleGetConversations(ws) {
    const meId = this.getUserId(ws);
    if (!meId) return;
    const { results } = await this.env.DB.prepare(`
      SELECT c.*, CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END AS peer_id
      FROM conversations c WHERE c.user_a = ? OR c.user_b = ?
      ORDER BY c.last_at DESC
    `).bind(meId, meId, meId).all();

    const list = [];
    for (const c of results || []) {
      const peer = await this.env.DB.prepare("SELECT id, name, phone FROM users WHERE id = ?").bind(c.peer_id).first();
      list.push({
        id: c.id,
        peer: peer ? { ...peer, online: this.online.has(peer.id) && this.online.get(peer.id).size > 0 } : { id: c.peer_id, name: "?", phone: "", online: false },
        lastAt: c.last_at,
        lastBody: c.last_body
      });
    }
    this.send(ws, { type: "conversations", list });
  }

  async handleGetOrCreate(ws, msg) {
    const meId = this.getUserId(ws);
    if (!meId) return;
    const peerId = Number(msg.peerId);
    const peer = await this.env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(peerId).first();
    if (!peer) throw new Error("no-peer");

    const lo = Math.min(meId, peerId), hi = Math.max(meId, peerId);
    let conv = await this.env.DB.prepare(
      "SELECT * FROM conversations WHERE (user_a=? AND user_b=?) OR (user_a=? AND user_b=?)"
    ).bind(lo, hi, hi, lo).first();

    if (!conv) {
      const res = await this.env.DB.prepare("INSERT INTO conversations (user_a, user_b) VALUES (?, ?)").bind(lo, hi).run();
      conv = { id: res.meta.last_row_id };
    }
    this.send(ws, { type: "conversation", id: conv.id });
  }

  async handleGetMessages(ws, msg) {
    const meId = this.getUserId(ws);
    if (!meId) return;
    const convId = Number(msg.convId);
    const before = Number(msg.beforeId) || 1e15;
    const limit = Math.min(50, Number(msg.limit) || 30);

    const conv = await this.env.DB.prepare("SELECT * FROM conversations WHERE id = ?").bind(convId).first();
    if (!conv || (conv.user_a !== meId && conv.user_b !== meId)) throw new Error("no-conv");

    const { results } = await this.env.DB.prepare(`
      SELECT id, from_id AS from, body, at FROM messages
      WHERE conv_id = ? AND id < ?
      ORDER BY id DESC LIMIT ?
    `).bind(convId, before, limit).all();

    const messages = (results || []).reverse();
    this.send(ws, { type: "messages", convId, messages, hasMore: messages.length === limit });
  }

  async handleSendMessage(ws, msg) {
    const meId = this.getUserId(ws);
    if (!meId) return;
    const convId = Number(msg.convId);
    const body = String(msg.body || "").slice(0, 2000);
    if (!body) throw new Error("empty");

    const conv = await this.env.DB.prepare("SELECT * FROM conversations WHERE id = ?").bind(convId).first();
    if (!conv || (conv.user_a !== meId && conv.user_b !== meId)) throw new Error("no-conv");

    const at = Date.now();
    const res = await this.env.DB.prepare(
      "INSERT INTO messages (conv_id, from_id, body, at) VALUES (?, ?, ?, ?)"
    ).bind(convId, meId, body, at).run();

    await this.env.DB.prepare("UPDATE conversations SET last_at = ?, last_body = ? WHERE id = ?").bind(at, body.slice(0, 80), convId).run();

    const m = { id: res.meta.last_row_id, convId, from: meId, body, at };
    const payload = { type: "new-message", message: m, convId };
    this.send(ws, payload);

    const peerId = conv.user_a === meId ? conv.user_b : conv.user_a;
    this.broadcastToUser(peerId, payload);
  }

  handleTyping(ws, msg) {
    const meId = this.getUserId(ws);
    if (!meId) return;
    // simplified
  }

  async relayCall(ws, msg) {
    const meId = this.getUserId(ws);
    if (!meId) return;

    let peerId = Number(msg.peerId);
    if (!peerId && msg.convId) {
      const conv = await this.env.DB.prepare("SELECT user_a, user_b FROM conversations WHERE id = ?").bind(Number(msg.convId)).first();
      if (conv) peerId = conv.user_a === meId ? conv.user_b : conv.user_a;
    }
    if (peerId && peerId !== meId) {
      this.broadcastToUser(peerId, { ...msg, from: meId });
    }
  }
}
