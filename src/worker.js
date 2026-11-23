import { KontakRoom } from "./kontak-room.js";
import { vapidPublicKey } from "./push.js";
import { handleMedia } from "./media.js";
import { handleVerify } from "./verify.js";
import { sha256 } from "./session.js";

export { KontakRoom };

const STUN_ONLY = {
  iceServers: [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }]
};

let warnedNoTurn = false;

// Cloudflare Calls TURN when TURN_KEY_ID / TURN_API_TOKEN secrets are set,
// otherwise STUN only (calls still work on most networks, not behind strict NAT).
export async function iceServersFor(env) {
  if (env.TURN_KEY_ID && env.TURN_API_TOKEN) {
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.TURN_API_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ ttl: 86400 })
        }
      );
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
        if (list.length) return { iceServers: list, turn: true };
      }
      console.warn("turn: Cloudflare Calls credentials request failed", res.status);
    } catch (e) {
      console.warn("turn: Cloudflare Calls unreachable", e && e.message);
    }
  } else if (!warnedNoTurn) {
    warnedNoTurn = true;
    console.warn("turn: TURN_KEY_ID / TURN_API_TOKEN not set, serving STUN only");
  }
  return { ...STUN_ONLY, turn: false };
}

function isUpgrade(request) {
  return String(request.headers.get("Upgrade") || "").toLowerCase() === "websocket";
}

function originAllowed(request, url, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  if (host === url.host) return true;
  const extra = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return extra.some((o) => { try { return new URL(o).host === host; } catch { return false; } });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/version") {
        return Response.json({ build: "v29" }, { headers: { "Cache-Control": "no-store" } });
      }

      if (url.pathname === "/vapid") {
        try {
          return Response.json({ key: vapidPublicKey(env) }, { headers: { "Cache-Control": "no-store" } });
        } catch {
          return Response.json({ error: "vapid-missing" }, { status: 503, headers: { "Cache-Control": "no-store" } });
        }
      }

      if (url.pathname === "/media" || url.pathname.startsWith("/media/")) {
        return handleMedia(request, env, url);
      }

      if (url.pathname === "/verify" || url.pathname.startsWith("/verify/")) {
        return handleVerify(request, env, url);
      }

      if (url.pathname === "/turn") {
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        if (!token) return new Response("auth", { status: 401 });
        const row = await env.DB.prepare(
          "SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?"
        ).bind(await sha256(token), Date.now()).first();
        if (!row) return new Response("auth", { status: 401 });
        const body = await iceServersFor(env);
        return new Response(JSON.stringify(body), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      }

      if (url.pathname === "/ws" || isUpgrade(request)) {
        if (!isUpgrade(request)) {
          return new Response("Expected WebSocket", { status: 426 });
        }
        if (!originAllowed(request, url, env)) return new Response("origin", { status: 403 });
        const id = env.KONTAK.idFromName("global");
        return env.KONTAK.get(id).fetch(request);
      }

      if (env.ASSETS) {
        const res = await env.ASSETS.fetch(request);
        if (res.status !== 404) {
          const path = url.pathname;
          const dynamic = path === "/" || /\.(html|js|css)$/.test(path);
          if (!dynamic) return res;
          const headers = new Headers(res.headers);
          headers.set("Cache-Control", "no-cache");
          return new Response(res.body, { status: res.status, headers });
        }
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return new Response("Error", { status: 500 });
    }
  }
};
