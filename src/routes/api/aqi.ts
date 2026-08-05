import { createFileRoute } from "@tanstack/react-router";

/**
 * Same-origin proxy for Open-Meteo air quality.
 * Avoids flaky third-party browser fetches (Safari ITP / content blockers).
 */
export const Route = createFileRoute("/api/aqi")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const src = new URL(request.url);
        const lat = src.searchParams.get("lat");
        const lon = src.searchParams.get("lon");
        if (lat == null || lon == null) {
          return Response.json(
            { error: "lat and lon are required" },
            { status: 400 },
          );
        }
        const latitude = Number(lat);
        const longitude = Number(lon);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          return Response.json({ error: "invalid coordinates" }, { status: 400 });
        }

        const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
        url.searchParams.set("latitude", String(latitude));
        url.searchParams.set("longitude", String(longitude));
        url.searchParams.set(
          "current",
          "us_aqi,pm2_5,pm10,ozone,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide",
        );
        url.searchParams.set("hourly", "us_aqi,pm2_5,ozone");
        url.searchParams.set("forecast_days", "4");
        url.searchParams.set("timezone", "auto");

        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 12_000);
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
            headers: {
              // Short browser cache; React Query owns longer client cache
              "Cache-Control": "public, max-age=60",
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "upstream failed";
          return Response.json({ error: message }, { status: 502 });
        }
      },
    },
  },
});
