import { createFileRoute } from "@tanstack/react-router";

/** Same-origin proxy for Open-Meteo geocoding search. */
export const Route = createFileRoute("/api/geocode")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const src = new URL(request.url);
        const name = (src.searchParams.get("name") ?? "").trim();
        if (name.length < 2) {
          return Response.json({ results: [] });
        }

        const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
        url.searchParams.set("name", name);
        url.searchParams.set("count", "8");
        url.searchParams.set("language", "en");
        url.searchParams.set("format", "json");

        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 10_000);
          let res: Response;
          try {
            res = await fetch(url.toString(), {
              headers: { Accept: "application/json" },
              signal: ctrl.signal,
            });
          } finally {
            clearTimeout(timer);
          }
          if (!res.ok) {
            return Response.json(
              { error: `upstream ${res.status}` },
              { status: 502 },
            );
          }
          const data = await res.json();
          return Response.json(data, {
            headers: { "Cache-Control": "public, max-age=300" },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "upstream failed";
          return Response.json({ error: message }, { status: 502 });
        }
      },
    },
  },
});
