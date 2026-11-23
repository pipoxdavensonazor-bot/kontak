import { exports } from "cloudflare:workers";

export const ORIGIN = "https://kontak.test";

export function call(path, init = {}) {
  return exports.default.fetch(new Request(ORIGIN + path, init));
}

const used = new Set();
export function newPhone() {
  let p;
  do { p = "509" + String(30000000 + Math.floor(Math.random() * 69999999)); } while (used.has(p));
  used.add(p);
  return p;
}

export async function connect(headers = { Upgrade: "websocket", Origin: ORIGIN }) {
  const res = await call("/ws", { headers });
  const ws = res.webSocket;
  if (!ws) return { res };
  ws.accept();
  const inbox = [];
  const waiters = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const client = {
    res,
    ws,
    send: (obj) => ws.send(JSON.stringify(obj)),
    next(type, timeout = 5000) {
      const match = typeof type === "function" ? type : (m) => m.type === type;
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k >= 0) { waiters.splice(k, 1); reject(new Error("timeout waiting for " + type + " inbox=" + JSON.stringify(inbox))); }
        }, timeout);
      });
    },
    async request(obj, type) {
      client.send(obj);
      return client.next((m) => m.type === type || m.type === "error");
    },
    close: () => { try { ws.close(); } catch {} }
  };
  return client;
}

export async function register(name, password = "motdepasse123") {
  const c = await connect();
  const phone = newPhone();
  const res = await c.request({ type: "register", name, phone, password }, "auth-ok");
  if (res.type !== "auth-ok") throw new Error("register failed: " + JSON.stringify(res));
  c.user = res.user;
  c.token = res.token;
  c.phone = phone;
  return c;
}
