const CACHE = "kontak-v15";

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
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const visible = windows.some((c) => c.visibilityState === "visible" && c.focused);
    if (visible && data.kind !== "call") return;
    await self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag || "kontak",
      renotify: true,
      data,
      vibrate: data.kind === "call" ? [300, 120, 300, 120, 300] : [80]
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        await client.focus();
        client.postMessage({ type: "push-open", kind: event.notification.data && event.notification.data.kind });
        return;
      }
    }
    await self.clients.openWindow("/");
  })());
});
