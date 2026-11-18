import { KontakRoom } from "./kontak-room.js";

export { KontakRoom };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws" || request.headers.get("Upgrade") === "websocket") {
      const id = env.KONTAK.idFromName("global");
      const stub = env.KONTAK.get(id);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};
