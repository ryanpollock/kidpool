// Carpool Crew — Service Worker for PWA push notifications + cache-busting
// Handles push events, notification clicks, and network-first navigation
// to defeat iOS PWA WebKit's aggressive stale-page cache.

// ── Lifecycle: activate new SW immediately ───────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// ── Fetch: network-first for navigations, pass-through otherwise ─
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          // Always fetch fresh HTML from the network — bypasses iOS PWA cache.
          const networkResponse = await fetch(request, { cache: "no-store" });
          return networkResponse;
        } catch {
          // Offline: fall back to the cached page (or index.html).
          const cache = await caches.open("carpool-pages");
          const cached = await cache.match(request);
          if (cached) return cached;
          return cache.match("/index.html");
        }
      })(),
    );
    return;
  }
  // All other requests (hashed JS/CSS, images, storage) use the browser's
  // default cache — Vite's hashed assets are immutable and cache fine.
});

// ── Push notifications ───────────────────────────────────────────
self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title ?? "Carpool Crew";
  const body = payload.body ?? "";
  const url = payload.url ?? "/";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      data: { url },
      tag: payload.tag ?? "carpool",
      renotify: true,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url ?? "/";

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      for (const client of allClients) {
        if (client.url.includes(self.location.origin)) {
          if ("focus" in client) {
            await client.focus();
            if ("navigate" in client) {
              await client.navigate(targetUrl);
            }
            return;
          }
        }
      }

      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })(),
  );
});