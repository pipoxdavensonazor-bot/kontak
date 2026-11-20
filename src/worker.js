import { KontakRoom } from "./kontak-room.js";

export { KontakRoom };

const TURN_SECRET = "openrelayprojectsecret";
const TURN_HOST = "staticauth.openrelay.metered.ca";

async function defaultIceServers(env) {
  if (env.TURN_KEY_ID && env.TURN_API_TOKEN) {
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
    if (res.ok) return res.json();
  }

  const username = String(Math.floor(Date.now() / 1000) + 12 * 3600);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TURN_SECRET),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username));
  const credential = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return {
    iceServers: [
      { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
      {
        username,
        credential,
        urls: [
          `turn:${TURN_HOST}:80`,
          `turn:${TURN_HOST}:80?transport=tcp`,
          `turn:${TURN_HOST}:443`,
          `turns:${TURN_HOST}:443?transport=tcp`
        ]
      }
    ]
  };
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/turn") {
        const body = await defaultIceServers(env);
        return new Response(JSON.stringify(body), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
          }
        });
      }

      if (url.pathname === "/ws" || request.headers.get("Upgrade") === "websocket") {
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
