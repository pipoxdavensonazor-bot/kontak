const CACHE = "kontak-v19";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/ws") return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
      }
      return res;
    } catch {
      const cached = await caches.match(req);
      return cached || caches.match("/index.html");
    }
  })());
});

self.addEventListener("push", (event) => {
  let data = { title: "Kontak", body: "Nouvo mesaj", tag: "kontak", kind: "msg" };
  try { data = Object.assign(data, event.data.json()); } catch {}
  const call = data.kind === "call";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const visible = windows.some((c) => c.visibilityState === "visible" && c.focused);
    if (visible && !call) return;
    await self.registration.showNotification(data.title || "Kontak", {
      body: data.body || "",
      tag: call ? "call" : (data.tag || "kontak"),
      renotify: true,
      requireInteraction: call,
      silent: false,
      data,
      vibrate: call ? [500, 200, 500, 200, 500, 200, 800] : [80],
      actions: call ? [{ action: "accept", title: "Asepte" }, { action: "decline", title: "Refize" }] : []
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const action = event.action || (data.kind === "call" ? "accept" : "open");
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        await client.focus();
        client.postMessage({ type: "push-call", action, kind: data.kind });
        return;
      }
    }
    const q = action === "decline" ? "/?call=decline" : action === "accept" ? "/?call=accept" : "/";
    await self.clients.openWindow(q);
  })());
});
