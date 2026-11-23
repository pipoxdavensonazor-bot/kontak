import { DurableObject } from "cloudflare:workers";
import { getDb, schema, eq, and, or, desc, lt } from "./db/index.js";
import { RegisterSchema, LoginSchema, validate, parseIncoming } from "./validation.js";
import { sendWebPush } from "./push.js";
import { mediaLabel } from "./media.js";

export function maskPhone(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.length < 6) return d ? "•••" : "";
  return d.slice(0, 3) + "•".repeat(d.length - 5) + d.slice(-2);
}

export class KontakRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.online = new Map();
    this.wsUser = new Map();
    this.busy = new Map();
    this.calls = new Map();
    this.rates = new Map();
    this.wsAt = new Map();
    this.seen = new Map();
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
    this.wsAt.set(server, Date.now());
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const raw = typeof message === "string" ? message : "";
    if (raw.length > 32000) {
      this.send(ws, { type: "error", error: "too-big" });
      return;
    }
    let msg;
    try { msg = JSON.parse(raw || message); } catch {
      this.send(ws, { type: "error", error: "bad-json" });
      return;
    }
    if (!this.wsUser.get(ws)) {
      const started = this.wsAt.get(ws) || Date.now();
      if (Date.now() - started > 20000 && msg.type !== "login" && msg.type !== "register" && msg.type !== "resume") {
        try { ws.close(4001, "auth"); } catch {}
        return;
      }
    }
    const rateKey = String(this.wsUser.get(ws) || this.wsAt.get(ws) || "x");
    if (!this.hit(rateKey, 50, 10000)) {
      this.send(ws, { type: "error", error: "slow-down" });
      return;
    }

    try {
      msg = parseIncoming(msg);
      await this.ensureSchema();
      switch (msg.type) {
        case "register": return await this.handleRegister(ws, msg);
        case "login": return await this.handleLogin(ws, msg);
        case "resume": return await this.handleResume(ws, msg);
        case "logout": return await this.handleLogout(ws);
        case "search": return await this.handleSearch(ws, msg);
        case "getConversations": return await this.handleGetConversations(ws);
        case "getOrCreateConversation": return await this.handleGetOrCreate(ws, msg);
        case "dial": return await this.handleDial(ws, msg);
        case "getMessages": return await this.handleGetMessages(ws, msg);
        case "sendMessage": return await this.handleSendMessage(ws, msg);
        case "setProfile": return await this.handleSetProfile(ws, msg);
        case "createGroup": return await this.handleCreateGroup(ws, msg);
        case "getPhoto": return await this.handleGetPhoto(ws, msg);
        case "markRead": return await this.handleMarkRead(ws, msg);
        case "pushSubscribe": return await this.handlePushSubscribe(ws, msg);
        case "getCalls": return await this.handleGetCalls(ws);
        case "matchContacts": return await this.handleMatchContacts(ws, msg);
        case "callAdd": return await this.handleCallAdd(ws, msg);
        case "dismissCall": return await this.handleDismissCall(ws);
        case "replayCall": return await this.handleReplay(ws);
        case "meshOffer":
        case "meshAnswer":
        case "meshIce":
          return await this.relayMesh(ws, msg);
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
        let ring = null;
        try { ring = await this.ctx.storage.get("ring:" + userId); } catch {}
        if (ring && Date.now() - ring.at < 50000) {
          await this.broadcastPresence(userId, false);
          return;
        }
        if (peer) await this.clearRing(peer);
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

  async addOnline(userId, ws) {
    this.track(userId, ws);
    let ring = null;
    try { ring = await this.ctx.storage.get("ring:" + userId); } catch {}
    const live = ring && Date.now() - ring.at < 50000;
    try { ws.serializeAttachment({ userId, busyWith: live ? ring.from : null }); } catch {}
    if (!live) return;
    this.setBusy(ring.from, userId);
    this.setBusy(userId, ring.from);
    this.send(ws, ring.msg);
  }

  async saveRing(userId, from, fromName, msg) {
    try {
      await this.ctx.storage.put("ring:" + userId, { at: Date.now(), from, fromName, to: userId, msg });
      const alarm = await this.ctx.storage.getAlarm();
      if (!alarm) await this.ctx.storage.setAlarm(Date.now() + 8000);
    } catch (e) { console.error("ring", e); }
  }

  async clearRing(userId) {
    try { await this.ctx.storage.delete("ring:" + userId); } catch {}
  }

  async alarm() {
    let list;
    try { list = await this.ctx.storage.list({ prefix: "ring:" }); } catch { return; }
    const now = Date.now();
    let more = false;
    for (const [key, ring] of list) {
      if (!ring || now - ring.at > 45000) {
        try { await this.ctx.storage.delete(key); } catch {}
        continue;
      }
      await this.pushTo(ring.to, {
        title: "Apèl Kontak",
        body: (ring.fromName || "Yon moun") + " ap rele ou",
        tag: "call",
        kind: "call"
      });
      more = true;
    }
    if (more) {
      try { await this.ctx.storage.setAlarm(Date.now() + 8000); } catch {}
    }
  }

  async handleDismissCall(ws) {
    const meId = this.needUser(ws);
    let ring = null;
    try { ring = await this.ctx.storage.get("ring:" + meId); } catch {}
    await this.clearRing(meId);
    this.clearBusy(meId);
    if (ring && ring.from) {
      this.clearBusy(ring.from);
      this.broadcastToUser(ring.from, { type: "callDecline", from: meId, convId: ring.msg && ring.msg.convId });
    }
  }

  async handleReplay(ws) {
    const meId = this.needUser(ws);
    let ring = null;
    try { ring = await this.ctx.storage.get("ring:" + meId); } catch {}
    if (!ring || Date.now() - ring.at > 50000) {
      this.send(ws, { type: "call-ended" });
      return;
    }
    this.setBusy(ring.from, meId);
    this.setBusy(meId, ring.from);
    this.send(ws, ring.msg);
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
          "CREATE TABLE IF NOT EXISTS members (conv_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (conv_id, user_id))",
          "CREATE TABLE IF NOT EXISTS push_subs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, endpoint TEXT UNIQUE NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL)",
          "CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, peer_id INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL)",
          "ALTER TABLE messages ADD COLUMN client_id TEXT DEFAULT ''",
          "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
          "CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, conv_id INTEGER NOT NULL, owner_id INTEGER NOT NULL, message_id INTEGER, kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, duration_ms INTEGER DEFAULT 0, r2_key TEXT NOT NULL, created_at INTEGER NOT NULL)",
          "CREATE UNIQUE INDEX IF NOT EXISTS messages_client ON messages(conv_id, client_id) WHERE client_id != ''",
          "ALTER TABLE users ADD COLUMN phone_verified_at INTEGER",
          "CREATE TABLE IF NOT EXISTS phone_otps (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, user_id INTEGER NOT NULL, code_hash TEXT NOT NULL, salt TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER, ip TEXT, sender TEXT)"
        ];
        for (const sql of sqls) {
          try { await this.env.DB.prepare(sql).run(); } catch {}
        }
      })();
    }
    return this._schema;
  }

  async pushTo(userId, data) {
    if (!this.env.VAPID_PUBLIC || !this.env.VAPID_JWK) return;
    let rows = [];
    try {
      const q = await this.env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?").bind(userId).all();
      rows = q.results || [];
    } catch {
      return;
    }
    const payload = JSON.stringify(data);
    for (const row of rows) {
      try {
        const status = await sendWebPush(row, payload, data.kind === "call", this.env);
        if (status === 404 || status === 410) {
          await this.env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(row.endpoint).run();
        } else if (status < 200 || status >= 300) {
          console.error("push-status", status);
        }
      } catch (e) {
        console.error("push", e);
      }
    }
  }

  async handlePushSubscribe(ws, msg) {
    const meId = this.needUser(ws);
    const sub = msg.subscription || {};
    const endpoint = String(sub.endpoint || "").slice(0, 800);
    const p256dh = sub.keys && String(sub.keys.p256dh || "");
    const auth = sub.keys && String(sub.keys.auth || "");
    if (!endpoint.startsWith("https://") || !p256dh || !auth) return;
    const previous = String(msg.previous || "");
    if (previous && previous !== endpoint) {
      await this.env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?").bind(previous, meId).run();
    }
    await this.env.DB.prepare(
      "INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth"
    ).bind(meId, endpoint, p256dh, auth).run();
    this.send(ws, { type: "push-ok" });
  }

  // Phone numbers are private: a full number is only returned when the caller
  // already knows it (exact search, contacts match, dial) or the person has
  // written to them. Everything else gets a masked number.
  pub(user, withPhoto, fullPhone = false) {
    if (!user) return null;
    const out = {
      id: user.id,
      name: user.name,
      phone: fullPhone ? user.phone : maskPhone(user.phone),
      online: this.isOnline(user.id),
      hasPhoto: user.photo ? 1 : 0
    };
    if (withPhoto && user.photo) out.photo = user.photo;
    return out;
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

  async summarize(c, meId, known) {
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
      peer: peer ? this.pub(peer, false, !!(known && known.has(peer.id))) : { id: peerId, name: "?", phone: "", online: false, hasPhoto: 0 },
      lastAt: c.lastAt,
      lastBody: c.lastBody,
      seen
    };
  }

  mediaOut(row) {
    return { id: row.id, kind: row.kind, mime: row.mime, size: Number(row.size), durationMs: Number(row.duration_ms) || 0 };
  }

  // Ids of people who sent `meId` at least one message in a direct conversation.
  async knownPeers(meId) {
    const q = await this.env.DB.prepare(
      "SELECT DISTINCT m.from_id AS id FROM messages m JOIN conversations c ON c.id = m.conv_id " +
      "WHERE COALESCE(c.is_group, 0) = 0 AND (c.user_a = ? OR c.user_b = ?) AND m.from_id != ?"
    ).bind(meId, meId, meId).all();
    return new Set((q.results || []).map((r) => r.id));
  }

  markSeen(userId, ids) {
    if (!userId) return;
    let set = this.seen.get(userId);
    if (!set) { set = new Set(); this.seen.set(userId, set); }
    for (const id of ids) {
      set.add(Number(id));
      if (set.size > 500) set.delete(set.values().next().value);
    }
  }

  // A profile photo is visible to people who share a conversation (direct or
  // group) with its owner, or who found the owner via search/contacts/call.
  async mayView(meId, otherId) {
    if (meId === otherId) return true;
    const seen = this.seen.get(meId);
    if (seen && seen.has(otherId)) return true;
    const direct = await this.env.DB.prepare(
      "SELECT 1 AS ok FROM conversations WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?) LIMIT 1"
    ).bind(meId, otherId, otherId, meId).first();
    if (direct) return true;
    const group = await this.env.DB.prepare(
      "SELECT 1 AS ok FROM members a JOIN members b ON a.conv_id = b.conv_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1"
    ).bind(meId, otherId).first();
    return !!group;
  }

  hit(key, limit, windowMs) {
    const now = Date.now();
    const rec = this.rates.get(key) || { n: 0, t: now };
    if (now - rec.t > windowMs) { rec.n = 0; rec.t = now; }
    rec.n += 1;
    this.rates.set(key, rec);
    return rec.n <= limit;
  }

  async sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async openSession(userId) {
    const raw = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const tokenHash = await this.sha256(raw);
    const expires = Date.now() + 30 * 24 * 3600 * 1000;
    await this.env.DB.prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"
    ).bind(tokenHash, userId, expires).run();
    return raw;
  }

  selfUser(user) {
    return {
      id: user.id,
      name: user.name,
      phone: user.phone,
      hasPhoto: user.photo ? 1 : 0,
      phoneVerified: !!(user.phoneVerifiedAt ?? user.phone_verified_at)
    };
  }

  async authOk(ws, user) {
    const me = this.selfUser(user);
    const token = await this.openSession(user.id);
    await this.addOnline(me.id, ws);
    try {
      const att = ws.deserializeAttachment() || {};
      att.tokenHash = await this.sha256(token);
      ws.serializeAttachment(att);
    } catch {}
    this.send(ws, { type: "auth-ok", user: me, token });
    await this.broadcastPresence(me.id, true);
  }

  async hashPass(password, salt) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations: 100000,
      hash: "SHA-256"
    }, key, 256);
    return "pbkdf2:" + [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async legacyHash(password, salt) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + password));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async handleRegister(ws, msg) {
    const data = validate(RegisterSchema, msg);
    const phone = data.phone;
    if (!this.hit("reg:" + phone, 5, 3600000)) throw new Error("slow-down");
    const name = data.name.trim().slice(0, 40);
    const password = data.password;

    const existing = await this.db.select().from(schema.users).where(eq(schema.users.phone, phone)).get();
    if (existing) throw new Error("phone-taken");

    const salt = crypto.randomUUID().replace(/-/g, "");
    const hash = await this.hashPass(password, salt);
    const res = await this.db.insert(schema.users).values({ name, phone, salt, hash, createdAt: Date.now() }).returning();
    const me = { id: res[0].id, name, phone, hasPhoto: 0, photo: "" };
    await this.authOk(ws, me);
  }

  async handleLogin(ws, msg) {
    const data = validate(LoginSchema, msg);
    const user = await this.db.select().from(schema.users).where(eq(schema.users.phone, data.phone)).get();
    if (!this.hit("login:" + data.phone, 8, 600000)) throw new Error("slow-down");
    if (!user) throw new Error("bad-creds");
    let ok = false;
    if (String(user.hash).startsWith("pbkdf2:")) ok = (await this.hashPass(data.password, user.salt)) === user.hash;
    else ok = (await this.legacyHash(data.password, user.salt)) === user.hash;
    if (!ok) throw new Error("bad-creds");
    if (!String(user.hash).startsWith("pbkdf2:")) {
      const next = await this.hashPass(data.password, user.salt);
      await this.db.update(schema.users).set({ hash: next }).where(eq(schema.users.id, user.id));
    }
    await this.authOk(ws, user);
  }

  async handleResume(ws, msg) {
    const token = String(msg.token || "");
    if (token.length < 32) throw new Error("bad-creds");
    const row = await this.env.DB.prepare(
      "SELECT user_id, expires_at FROM sessions WHERE token_hash = ?"
    ).bind(await this.sha256(token)).first();
    if (!row || Number(row.expires_at) < Date.now()) throw new Error("bad-creds");
    const user = await this.db.select().from(schema.users).where(eq(schema.users.id, row.user_id)).get();
    if (!user) throw new Error("bad-creds");
    const me = this.selfUser(user);
    await this.addOnline(me.id, ws);
    try {
      const att = ws.deserializeAttachment() || {};
      att.tokenHash = await this.sha256(token);
      ws.serializeAttachment(att);
    } catch {}
    this.send(ws, { type: "auth-ok", user: me, token });
    await this.broadcastPresence(me.id, true);
  }

  async handleLogout(ws) {
    const meId = this.needUser(ws);
    try {
      const att = ws.deserializeAttachment();
      if (att && att.tokenHash) {
        await this.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(att.tokenHash).run();
      }
    } catch {}
    await this.env.DB.prepare("DELETE FROM push_subs WHERE user_id = ?").bind(meId).run();
    this.send(ws, { type: "logged-out" });
  }

  async handleSearch(ws, msg) {
    const meId = this.needUser(ws);
    const raw = String(msg.q || "").trim();
    const q = raw.toLowerCase();
    const qd = raw.replace(/\D/g, "");
    const list = [];
    const ids = new Set();
    // Phone search: exact number (or its last 8+ digits), never a partial prefix scan.
    if (qd.length >= 8 && qd.length === raw.replace(/[\s+().-]/g, "").length) {
      const byPhone = await this.env.DB.prepare(
        "SELECT id FROM users WHERE id != ? AND (phone = ? OR phone LIKE ?) LIMIT 5"
      ).bind(meId, qd, "%" + qd).all();
      for (const u of byPhone.results || []) {
        const full = await this.db.select().from(schema.users).where(eq(schema.users.id, u.id)).get();
        if (full && !ids.has(full.id)) { ids.add(full.id); list.push(this.pub(full, false, true)); }
      }
    } else if (q.replace(/[%_]/g, "").length >= 2) {
      const nameLike = "%" + q.replace(/[%_]/g, "") + "%";
      const byName = await this.env.DB.prepare(
        "SELECT id FROM users WHERE id != ? AND lower(name) LIKE ? LIMIT 12"
      ).bind(meId, nameLike).all();
      for (const u of byName.results || []) {
        const full = await this.db.select().from(schema.users).where(eq(schema.users.id, u.id)).get();
        if (full && !ids.has(full.id)) { ids.add(full.id); list.push(this.pub(full)); }
      }
    }
    this.markSeen(meId, ids);
    this.send(ws, { type: "search-results", results: list });
  }

  async handleGetConversations(ws) {
    const meId = this.needUser(ws);
    const convs = await this.convsFor(meId);
    const known = await this.knownPeers(meId);
    const list = [];
    for (const c of convs) list.push(await this.summarize(c, meId, known));
    this.send(ws, { type: "conversations", list });
  }

  async handleGetOrCreate(ws, msg, knowsPhone = false) {
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
    const full = knowsPhone || (await this.knownPeers(meId)).has(peer.id);
    this.send(ws, { type: "conversation", id: conv.id, peer: this.pub(peer, false, full) });
  }

  async handleDial(ws, msg) {
    const phone = String(msg.phone || "").replace(/\D/g, "");
    const peer = await this.db.select().from(schema.users).where(eq(schema.users.phone, phone)).get();
    if (!peer) throw new Error("no-peer");
    this.markSeen(this.needUser(ws), [peer.id]);
    return this.handleGetOrCreate(ws, { peerId: peer.id }, true);
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

    if (results.length) {
      const ids = results.map((r) => r.id);
      try {
        const q = await this.env.DB.prepare(
          "SELECT * FROM media WHERE message_id IN (" + ids.map(() => "?").join(",") + ")"
        ).bind(...ids).all();
        const byMsg = new Map((q.results || []).map((r) => [Number(r.message_id), r]));
        for (const r of results) {
          const row = byMsg.get(r.id);
          if (row) { r.kind = row.kind; r.media = this.mediaOut(row); }
        }
      } catch (e) { console.error("media-join", e); }
    }

    await this.markRead(meId, convId);
    this.send(ws, { type: "messages", convId, messages: results.reverse(), hasMore: results.length === limit });
  }

  async handleSendMessage(ws, msg) {
    const meId = this.needUser(ws);
    const convId = Number(msg.convId);
    let body = String(msg.body || "").slice(0, 2000);
    const clientId = String(msg.clientId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
    const mediaId = msg.mediaId ? String(msg.mediaId) : "";
    if (!body.trim() && !mediaId) throw new Error("empty");

    const conv = await this.db.select().from(schema.conversations).where(eq(schema.conversations.id, convId)).get();
    if (!(await this.inConv(conv, meId))) throw new Error("no-conv");

    let media = null;
    if (mediaId) {
      const row = await this.env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(mediaId).first();
      if (!row || Number(row.owner_id) !== meId || Number(row.conv_id) !== convId) throw new Error("no-media");
      if (row.message_id) {
        // already sent (retry from the outbox): acknowledge the existing message
        this.send(ws, { type: "message-ack", clientId, id: row.message_id, convId });
        return;
      }
      media = this.mediaOut(row);
      // Old clients (v23) only read `body`: give them a readable fallback.
      body = mediaLabel(row.kind, row.duration_ms);
    }

    if (clientId) {
      const dup = await this.env.DB.prepare(
        "SELECT id FROM messages WHERE conv_id = ? AND client_id = ?"
      ).bind(convId, clientId).first();
      if (dup) {
        this.send(ws, { type: "message-ack", clientId, id: dup.id, convId });
        return;
      }
    }

    const at = Date.now();
    const res = await this.env.DB.prepare(
      "INSERT INTO messages (conv_id, from_id, body, at, read_at, client_id) VALUES (?, ?, ?, ?, 0, ?)"
    ).bind(convId, meId, body, at, clientId).run();
    const id = res.meta && res.meta.last_row_id;
    if (media) await this.env.DB.prepare("UPDATE media SET message_id = ? WHERE id = ?").bind(id, media.id).run();
    await this.db.update(schema.conversations)
      .set({ lastAt: at, lastBody: body.slice(0, 80) })
      .where(eq(schema.conversations.id, convId));

    const payload = {
      type: "new-message",
      convId,
      message: { id, convId, from: meId, body, at, readAt: 0, ...(media ? { kind: media.kind, media } : {}) }
    };
    this.send(ws, { type: "message-ack", clientId, id, convId });
    this.send(ws, payload);
    for (const peer of await this.others(conv, meId)) {
      this.broadcastToUser(peer, payload);
      if (!this.isOnline(peer)) {
        const label = media ? (media.kind === "voice" ? "🎤 Not vokal" : "📷 Foto") : "Nouvo mesaj";
        await this.pushTo(peer, { title: "Kontak", body: label, tag: "msg", kind: "msg" });
      }
    }
  }

  async handleSetProfile(ws, msg) {
    const meId = this.needUser(ws);
    const photo = String(msg.photo || "");
    if (photo && (!photo.startsWith("data:image/") || photo.length > 14000)) throw new Error("photo-big");
    const name = String(msg.name || "").trim().slice(0, 40);
    const patch = {};
    if (name) patch.name = name;
    if (photo) patch.photo = photo;
    if (!Object.keys(patch).length) return;
    await this.db.update(schema.users).set(patch).where(eq(schema.users.id, meId));
    const user = await this.db.select().from(schema.users).where(eq(schema.users.id, meId)).get();
    this.send(ws, { type: "profile-ok", user: this.pub(user, true, true) });
  }

  async handleGetPhoto(ws, msg) {
    const meId = this.needUser(ws);
    const id = Number(msg.id);
    if (!id) return;
    if (!(await this.mayView(meId, id))) {
      this.send(ws, { type: "photo", id, photo: "" });
      return;
    }
    const user = await this.db.select().from(schema.users).where(eq(schema.users.id, id)).get();
    const photo = user && user.photo && user.photo.length <= 80000 ? user.photo : "";
    this.send(ws, { type: "photo", id, photo });
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
      try {
        const att = sock.deserializeAttachment() || {};
        att.userId = userId;
        att.busyWith = peerId;
        sock.serializeAttachment(att);
      } catch {}
    }
  }

  clearBusy(userId) {
    this.busy.delete(userId);
    const set = this.online.get(userId);
    if (!set) return;
    for (const sock of set) {
      try {
        const att = sock.deserializeAttachment() || {};
        att.userId = userId;
        att.busyWith = null;
        sock.serializeAttachment(att);
      } catch {}
    }
  }

  async rememberCall(call) {
    this.calls.set(call.id, call);
    try { await this.ctx.storage.put("call:" + call.id, call); } catch {}
    try { await this.ctx.storage.put("pair:" + Math.min(call.from, call.to) + ":" + Math.max(call.from, call.to), call.id); } catch {}
  }

  async lookupCall(id) {
    if (!id) return null;
    if (this.calls.has(id)) return this.calls.get(id);
    try {
      const call = await this.ctx.storage.get("call:" + id);
      if (call) this.calls.set(id, call);
      return call || null;
    } catch { return null; }
  }

  async pairCall(a, b) {
    try {
      const id = await this.ctx.storage.get("pair:" + Math.min(a, b) + ":" + Math.max(a, b));
      return this.lookupCall(id);
    } catch { return null; }
  }

  liveCall(call) {
    return !!(call && call.state !== "ended" && call.state !== "declined" && Date.now() - call.at < 2 * 3600 * 1000);
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
    let fresh = false;
    let call = msg.callId ? await this.lookupCall(String(msg.callId)) : await this.pairCall(meId, peerId);
    if (msg.type !== "callOffer" && msg.callId && (!call || (call.from !== meId && call.to !== meId))) {
      this.send(ws, { type: "error", error: "no-call" });
      return;
    }
    if (call && call.state === "ended" && msg.type !== "callOffer") {
      this.send(ws, { type: "call-ended", callId: call.id });
      return;
    }

    if (msg.type === "callOffer") {
      const same = this.liveCall(call) && ((call.from === meId && call.to === peerId) || (call.from === peerId && call.to === meId));
      if (same) {
        msg.callId = call.id;
      } else {
        const peerBusy = this.busy.get(peerId);
        const meBusy = this.busy.get(meId);
        const peerGone = peerBusy && !this.isOnline(peerBusy);
        const meGone = meBusy && !this.isOnline(meBusy);
        if (peerGone) this.busy.delete(peerId);
        if (meGone || (meBusy && meBusy !== peerId)) {
          this.busy.delete(meId);
          if (meBusy && this.busy.get(meBusy) === meId) this.busy.delete(meBusy);
        }
        const stillPeer = this.busy.get(peerId);
        const stillMe = this.busy.get(meId);
        if ((stillPeer && stillPeer !== meId && this.isOnline(stillPeer)) || (stillMe && stillMe !== peerId)) {
          this.send(ws, { type: "callBusy", convId: msg.convId, fromName });
          return;
        }
        call = { id: crypto.randomUUID(), from: meId, to: peerId, convId: Number(msg.convId) || 0, state: "ringing", at: Date.now() };
        await this.rememberCall(call);
        msg.callId = call.id;
        this.setBusy(meId, peerId);
        this.setBusy(peerId, meId);
        const kind = msg.audioOnly ? "audio" : "video";
        await this.recordCall(meId, peerId, kind, "out");
        await this.recordCall(peerId, meId, kind, "miss");
        fresh = true;
        this.send(ws, { type: "call-state", callId: call.id, convId: msg.convId });
      }
    }
    if (msg.type === "callAnswer") {
      if (call) {
        call.state = "accepted";
        await this.rememberCall(call);
        const mine = this.online.get(meId);
        if (mine) for (const sock of mine) if (sock !== ws) this.send(sock, { type: "callTaken", callId: call.id });
      }
      await this.markAnswered(meId, peerId);
      await this.clearRing(meId);
    }
    if (msg.type === "callHangup" || msg.type === "callDecline") {
      if (call) {
        call.state = msg.type === "callDecline" ? "declined" : "ended";
        await this.rememberCall(call);
      }
      this.clearBusy(meId);
      this.clearBusy(peerId);
      await this.clearRing(meId);
      await this.clearRing(peerId);
    }

    const delivered = { ...msg, from: meId, fromName, callId: (call && call.id) || msg.callId };
    this.broadcastToUser(peerId, delivered);
    if (fresh && peerId > 0) {
      await this.saveRing(peerId, meId, fromName, delivered);
      await this.pushTo(peerId, {
        title: "Apèl Kontak",
        body: fromName + " ap rele ou",
        tag: "call",
        kind: "call"
      });
    }
  }

  async recordCall(userId, peerId, kind, status) {
    if (!userId || !peerId || peerId < 0) return;
    try {
      await this.env.DB.prepare(
        "INSERT INTO calls (user_id, peer_id, kind, status, at) VALUES (?, ?, ?, ?, ?)"
      ).bind(userId, peerId, kind, status, Date.now()).run();
    } catch (e) { console.error("call-log", e); }
  }

  async markAnswered(userId, peerId) {
    try {
      await this.env.DB.prepare(
        "UPDATE calls SET status = 'in' WHERE id = (SELECT id FROM calls WHERE user_id = ? AND peer_id = ? AND status = 'miss' ORDER BY id DESC LIMIT 1)"
      ).bind(userId, peerId).run();
    } catch {}
  }

  async handleGetCalls(ws) {
    const meId = this.needUser(ws);
    const q = await this.env.DB.prepare(
      "SELECT c.id, c.peer_id as peerId, c.kind, c.status, c.at, u.name, u.phone FROM calls c LEFT JOIN users u ON u.id = c.peer_id WHERE c.user_id = ? ORDER BY c.id DESC LIMIT 40"
    ).bind(meId).all();
    const known = await this.knownPeers(meId);
    const list = (q.results || []).map((r) => ({ ...r, phone: known.has(r.peerId) ? r.phone : maskPhone(r.phone) }));
    this.send(ws, { type: "calls", list });
  }

  async handleMatchContacts(ws, msg) {
    const meId = this.needUser(ws);
    const phones = [...new Set((msg.phones || []).map((p) => String(p).replace(/\D/g, "")).filter((p) => p.length >= 8))].slice(0, 80);
    if (!phones.length) return this.send(ws, { type: "contacts", list: [] });
    const marks = phones.map(() => "?").join(",");
    const q = await this.env.DB.prepare(
      "SELECT id, name, phone FROM users WHERE phone IN (" + marks + ")"
    ).bind(...phones).all();
    const list = (q.results || []).filter((u) => u.id !== meId).map((u) => ({
      id: u.id, name: u.name, phone: u.phone, online: this.isOnline(u.id), hasPhoto: 0
    }));
    this.markSeen(meId, list.map((u) => u.id));
    this.send(ws, { type: "contacts", list });
  }

  async handleCallAdd(ws, msg) {
    const meId = this.needUser(ws);
    const to = Number(msg.to);
    if (!to || to === meId) throw new Error("no-peer");
    const peer = await this.db.select().from(schema.users).where(eq(schema.users.id, to)).get();
    if (!peer) throw new Error("no-peer");
    const me = await this.db.select().from(schema.users).where(eq(schema.users.id, meId)).get();
    const withIds = [meId, ...(Array.isArray(msg.with) ? msg.with.map(Number) : [])].filter((id, i, a) => id > 0 && id !== to && a.indexOf(id) === i);
    const people = [];
    for (const id of withIds) {
      const u = id === meId ? me : await this.db.select().from(schema.users).where(eq(schema.users.id, id)).get();
      if (u) people.push({ id: u.id, name: u.name });
    }
    await this.recordCall(meId, to, "audio", "out");
    await this.recordCall(to, meId, "audio", "miss");
    this.markSeen(to, people.map((p) => p.id));
    this.markSeen(meId, [to]);
    this.broadcastToUser(to, {
      type: "callInvite",
      from: meId,
      fromName: me ? me.name : "?",
      convId: msg.convId,
      with: people
    });
    await this.pushTo(to, { title: "Apèl Kontak", body: (me ? me.name : "Yon moun") + " vle ajoute ou nan apèl la", tag: "call", kind: "call" });
  }

  async relayMesh(ws, msg) {
    const meId = this.needUser(ws);
    const to = Number(msg.to);
    if (!to || to === meId) return;
    if (!this.busy.get(meId)) return;
    if (msg.type === "meshAnswer") await this.markAnswered(meId, to);
    this.markSeen(to, [meId]);
    const me = await this.db.select().from(schema.users).where(eq(schema.users.id, meId)).get();
    this.broadcastToUser(to, { ...msg, from: meId, fromName: me ? me.name : "?" });
  }
}
