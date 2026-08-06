import { createFileRoute } from "@tanstack/react-router";
import { buildAqiGrid, type GridSample } from "@/lib/aqi-grid";

/**
 * Sample current US AQI across a viewport bbox for regional map coloring.
 * Uses Open-Meteo multi-location in chunks (current us_aqi only — lightweight).
 */
export const Route = createFileRoute("/api/aqi-grid")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const src = new URL(request.url);
        const west = Number(src.searchParams.get("west"));
        const south = Number(src.searchParams.get("south"));
        const east = Number(src.searchParams.get("east"));
        const north = Number(src.searchParams.get("north"));
        if (![west, south, east, north].every(Number.isFinite)) {
          return Response.json(
            { error: "west, south, east, north required" },
            { status: 400 },
          );
        }
        // Very wide views still sample (coarser grid); only skip near-global spans
        const latSpan = Math.abs(north - south);
        let lonSpan = Math.abs(east - west);
        if (lonSpan > 180) lonSpan = 360 - lonSpan;
        if (latSpan > 70 || lonSpan > 160) {
          return Response.json(
            {
              error: "zoom in for regional coloring",
              samples: [],
            },
            { status: 200 },
          );
        }

        const points = buildAqiGrid(west, south, east, north, {
          // Denser grid → smoother IDW field on the client
          maxPoints: lonSpan > 80 ? 48 : lonSpan > 40 ? 64 : 80,
        });
        if (points.length === 0) {
          return Response.json({ samples: [] });
        }

        try {
          const samples = await fetchGridAqi(points);
          return Response.json(
            { samples },
            {
              headers: {
                "Cache-Control": "public, max-age=120",
              },
            },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : "upstream failed";
          return Response.json({ error: message, samples: [] }, { status: 502 });
        }
      },
    },
  },
});

const CHUNK = 40;

async function fetchGridAqi(
  points: { latitude: number; longitude: number }[],
): Promise<GridSample[]> {
  const out: GridSample[] = [];
  for (let i = 0; i < points.length; i += CHUNK) {
    const chunk = points.slice(i, i + CHUNK);
    const lats = chunk.map((p) => p.latitude).join(",");
    const lons = chunk.map((p) => p.longitude).join(",");
    const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
    url.searchParams.set("latitude", lats);
    url.searchParams.set("longitude", lons);
    url.searchParams.set("current", "us_aqi");
    url.searchParams.set("timezone", "auto");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
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
      throw new Error(`upstream ${res.status}`);
    }
    const data = (await res.json()) as unknown;
    // Multi-location → array of objects; single → one object
    const rows = Array.isArray(data) ? data : [data];
    for (let j = 0; j < chunk.length; j++) {
      const row = rows[j] as {
        latitude?: number;
        longitude?: number;
        current?: { us_aqi?: number | null };
      } | undefined;
      const aqi = row?.current?.us_aqi;
      out.push({
        latitude: chunk[j].latitude,
        longitude: chunk[j].longitude,
        us_aqi: typeof aqi === "number" && Number.isFinite(aqi) ? aqi : null,
      });
    }
  }
  return out;
}
