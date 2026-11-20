import { KontakRoom } from "./kontak-room.js";

export { KontakRoom };

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // WebSocket
      if (url.pathname === "/ws" || request.headers.get("Upgrade") === "websocket") {
        const id = env.KONTAK.idFromName("global");
        const stub = env.KONTAK.get(id);
        return stub.fetch(request);
      }

      // Serve assets directly without rewrite
      if (env.ASSETS) {
        const res = await env.ASSETS.fetch(request);
        if (res.status !== 404) return res;
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return new Response("Error", { status: 500 });
    }
  }
};
