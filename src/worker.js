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

      // Static assets
      if (url.pathname === "/" || !url.pathname.includes(".")) {
        const indexReq = new Request(new URL("/index.html", request.url), request);
        const res = await env.ASSETS.fetch(indexReq);
        if (res.status === 404) {
          return new Response("App not found", { status: 404 });
        }
        return res;
      }

      return await env.ASSETS.fetch(request);
    } catch (e) {
      console.error("Worker error:", e);
      return new Response(JSON.stringify({ error: "internal-error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};
