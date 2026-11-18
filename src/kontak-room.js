import { DurableObject } from "cloudflare:workers";

export class KontakRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.online = new Map();
  }

  async fetch(request) {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
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
      if (msg.type === "register") await this.handleRegister(ws, msg);
      else if (msg.type === "login") await this.handleLogin(ws, msg);
      else if (msg.type === "search") await this.handleSearch(ws, msg);
      else if (msg.type === "openConv") await this.handleOpenConv(ws, msg);
      else if (msg.type === "sendMsg") await this.handleSendMsg(ws, msg);
      else if (msg.type === "loadMsgs") await this.handleLoadMsgs(ws, msg);
      else if (["callOffer","callAnswer","callIce","callDecline","callHangup"].includes(msg.type)) this.relayCall(ws, msg);
    } catch (e) {
      this.send(ws, { type: "error", error: e.message || "server-error" });
    }
  }

  async webSocketClose(ws) {
    for (const [userId, set] of this.online) {
      if (set.has(ws)) {
        set.delete(ws);
        if (set.size === 0) this.online.delete(userId);
        this.broadcastPresence(userId, false);
        break;
      }
    }
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcastToUser(userId, obj) {
    const set = this.online.get(userId);
    if (!set) return;
    for (const ws of set) this.send(ws, obj);
  }

  addOnline(userId, ws) {
    if (!this.online.has(userId)) this.online.set(userId, new Set());
    this.online.get(userId).add(ws);
    ws.userId = userId;
  }

  getUserFromWs(ws) { return ws.userId ? { id: ws.userId } : null; }

  async hashPass(password, salt) {
    const data = new TextEncoder().encode(salt + password);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  // ... handlers (register, login, search, etc.) follow same pattern as previous version
}
