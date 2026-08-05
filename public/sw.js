/**
 * One-shot cleanup worker.
 *
 * Earlier builds precached HTML that could point at missing hashed CSS after
 * deploys, which leaves Safari with an unstyled shell. This worker:
 *  1. Clears all caches
 *  2. Unregisters itself
 *  3. Reloads open clients so they fetch a clean network document
 *
 * The app no longer registers a long-lived SW (see __root.tsx). Offline cache
 * can return later with a safer strategy.
 */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clients) {
        try {
          // Force a real navigation so the document + CSS come from network
          if ("navigate" in client) {
            await client.navigate(client.url);
          } else {
            client.postMessage({ type: "AETHER_SW_CLEARED" });
          }
        } catch {
          /* ignore */
        }
      }
    })(),
  );
});

// Do not intercept fetches — pass through to network while we tear down.
self.addEventListener("fetch", () => {});
