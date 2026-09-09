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
    (async () => {
      const tasks = [
        self.registration.showNotification(title, {
          body,
          icon: "/icon-192.png",
          badge: "/badge-96.png",
          data: { url },
          tag: payload.tag ?? "carpool",
          renotify: true,
        }),
      ];

      // App icon badge (iOS home-screen web apps, desktop Chrome): the
      // payload carries the recipient's total unread count. The app itself
      // re-syncs or clears the badge whenever it opens. Fail-soft — the
      // Badging API is absent on Android and in-browser.
      if (typeof payload.badge === "number" && payload.badge >= 0 && navigator.setAppBadge) {
        try {
          tasks.push(navigator.setAppBadge(payload.badge));
        } catch {
          // unsupported platform — notification still shows
        }
      }

      await Promise.all(tasks);
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url ?? "/";
  const tag = event.notification.tag ?? "";

  event.waitUntil(
    (async () => {
      // Thread deep link: prefer the payload URL's hash; fall back to the
      // notification tag (chat-<thread_id>) — some iOS versions drop
      // notification.data between showNotification and the tap, but the
      // tag survives (it drives same-thread notification replacement).
      let threadId = null;
      try {
        const hash = new URL(targetUrl, self.location.origin).hash;
        threadId = new URLSearchParams(hash.replace(/^#/, "")).get("thread");
      } catch {
        threadId = null;
      }
      if (!threadId && tag.startsWith("chat-")) {
        threadId = tag.slice("chat-".length);
      }
      const deepUrl = threadId
        ? `${self.location.origin}/#thread=${threadId}`
        : targetUrl;

      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      for (const client of allClients) {
        if (client.url.includes(self.location.origin)) {
          if ("focus" in client) {
            await client.focus();
          }
          // WindowClient.navigate() is unimplemented on iOS WebKit — tapping
          // while the app is suspended in the background would just focus
          // whatever screen was open. The running app listens for this
          // message and opens the thread itself; navigate() is still
          // attempted for page versions predating the listener.
          if ("navigate" in client) {
            try {
              await client.navigate(deepUrl);
            } catch {
              // unsupported — the postMessage below carries the link
            }
          }
          if (threadId) {
            client.postMessage({ type: "chat-open-thread", threadId });
          }
          return;
        }
      }

      // Cold start (app terminated): open at the deep link. The hash
      // survives launch, and the app stashes it in sessionStorage so the
      // service worker's first-install reload doesn't lose it.
      if (self.clients.openWindow) {
        await self.clients.openWindow(deepUrl);
      }
    })(),
  );
});