import { KontakRoom } from "./kontak-room.js";

export { KontakRoom };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // WebSocket
    if (url.pathname === "/ws" || request.headers.get("Upgrade") === "websocket") {
      const id = env.KONTAK.idFromName("global");
      const stub = env.KONTAK.get(id);
      return stub.fetch(request);
    }

    // Serve index.html for root and SPA routes
    if (url.pathname === "/" || !url.pathname.includes(".")) {
      const indexReq = new Request(new URL("/index.html", request.url), request);
      return env.ASSETS.fetch(indexReq);
    }

    // Other static files
    return env.ASSETS.fetch(request);
  }
};
