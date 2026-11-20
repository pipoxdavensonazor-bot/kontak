import { KontakRoom } from "./kontak-room.js";

export { KontakRoom };

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // WebSocket
      if (url.pathname === "/ws" || request.headers.get("Upgrade") === "websocket") {
        try {
          const id = env.KONTAK.idFromName("global");
          const stub = env.KONTAK.get(id);
          return await stub.fetch(request);
        } catch (e) {
          console.error("DO fetch error:", e);
          return new Response(JSON.stringify({ error: "websocket-unavailable" }), {
            status: 503,
            headers: { "Content-Type": "application/json" }
          });
        }
      }

      // Static assets - try ASSETS first
      if (env.ASSETS) {
        try {
          const path = url.pathname === "/" ? "/index.html" : url.pathname;
          const assetReq = new Request(new URL(path, request.url), request);
          const res = await env.ASSETS.fetch(assetReq);
          if (res.status !== 404) return res;
        } catch (e) {
          console.error("Assets error:", e);
        }
      }

      // Fallback for SPA
      if (url.pathname === "/" || !url.pathname.includes(".")) {
        return new Response("Chargement...", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error("Worker error:", e);
      return new Response(JSON.stringify({ error: "internal-error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};
