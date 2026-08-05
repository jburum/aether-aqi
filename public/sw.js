const CACHE = "aqi-watchlist-v4";
const PRECACHE = [
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Open-Meteo: network first, cache fallback
  if (url.hostname.includes("open-meteo.com")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // HTML navigations: always network. Never serve a stale shell that points at
  // missing hashed CSS/JS from a previous deploy.
  const accept = req.headers.get("accept") || "";
  if (req.mode === "navigate" || accept.includes("text/html")) {
    event.respondWith(
      fetch(req).catch(
        () =>
          caches.match(req).then(
            (r) =>
              r ||
              new Response("You are offline. Reconnect to load Air Quality Watchlist.", {
                status: 503,
                headers: { "Content-Type": "text/plain; charset=utf-8" },
              }),
          ),
      ),
    );
    return;
  }

  // Static assets: network first, cache on success, cache fallback offline
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (
          res.ok &&
          (url.pathname.startsWith("/assets") ||
            url.pathname.endsWith(".png") ||
            url.pathname.endsWith(".webmanifest") ||
            url.pathname.endsWith(".js") ||
            url.pathname.endsWith(".css"))
        ) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req)),
  );
});
