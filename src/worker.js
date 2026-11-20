import { KontakRoom } from "./kontak-room.js";

export { KontakRoom };

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

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
