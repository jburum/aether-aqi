export interface GeoResult {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  country_code?: string;
  admin1?: string;
  timezone?: string;
}

export interface AirQualityCurrent {
  time: string;
  us_aqi: number | null;
  pm2_5: number | null;
  pm10: number | null;
  ozone: number | null;
  carbon_monoxide: number | null;
  nitrogen_dioxide: number | null;
  sulphur_dioxide: number | null;
}

export interface AirQualityPayload {
  latitude: number;
  longitude: number;
  timezone: string;
  current: AirQualityCurrent;
  hourly: {
    time: string[];
    us_aqi: (number | null)[];
    pm2_5: (number | null)[];
    ozone: (number | null)[];
  };
}

function primaryPollutant(c: AirQualityCurrent): string {
  const entries: Array<[string, number | null]> = [
    ["PM2.5", c.pm2_5],
    ["PM10", c.pm10],
    ["O₃", c.ozone],
    ["NO₂", c.nitrogen_dioxide],
    ["SO₂", c.sulphur_dioxide],
    ["CO", c.carbon_monoxide],
  ];
  // Open-Meteo already gives US AQI; show highest PM2.5-ish signal as "main" for display.
  // Prefer PM2.5 when present since it drives most smoke events.
  if (c.pm2_5 != null && c.pm2_5 > 0) return "PM2.5";
  let best = "—";
  let bestVal = -1;
  for (const [name, val] of entries) {
    if (val != null && val > bestVal) {
      bestVal = val;
      best = name;
    }
  }
  return best;
}

async function fetchJson<T>(url: string, label: string, ms = 12_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`${label} failed (${res.status})`);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`${label} timed out`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchPlaces(query: string): Promise<GeoResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  // Same-origin proxy (see /api/geocode) — more reliable in Safari than direct third-party fetch
  const url = new URL("/api/geocode", typeof window !== "undefined" ? window.location.origin : "http://local");
  url.searchParams.set("name", q);
  const data = await fetchJson<{ results?: GeoResult[]; error?: string }>(
    url.pathname + url.search,
    "Place search",
  );
  if (data.error) throw new Error(data.error);
  return data.results ?? [];
}

export async function reverseGeocode(lat: number, lon: number): Promise<string> {
  // Open-Meteo has no reverse geocode; use bigdatacloud free endpoint as fallback-ish
  // Prefer a local label from coords if reverse fails.
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("reverse failed");
    const data = (await res.json()) as {
      city?: string;
      locality?: string;
      principalSubdivision?: string;
      countryCode?: string;
    };
    const city = data.city || data.locality || "Current location";
    const region = data.principalSubdivision || data.countryCode || "";
    return region ? `${city}, ${region}` : city;
  } catch {
    return `Here (${lat.toFixed(2)}, ${lon.toFixed(2)})`;
  }
}

export async function fetchAirQuality(
  lat: number,
  lon: number,
): Promise<AirQualityPayload & { mainPollutant: string }> {
  // Same-origin proxy (see /api/aqi) — Safari often blocks or stalls direct
  // calls to third-party weather APIs; proxy keeps the request first-party.
  const url = new URL(
    "/api/aqi",
    typeof window !== "undefined" ? window.location.origin : "http://local",
  );
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));

  const data = await fetchJson<AirQualityPayload & { error?: string }>(
    url.pathname + url.search,
    "Air quality",
  );
  if (data.error) throw new Error(data.error);
  if (!data.current) throw new Error("Air quality response missing current data");
  return { ...data, mainPollutant: primaryPollutant(data.current) };
}

export function placeLabel(p: Pick<GeoResult, "name" | "admin1" | "country_code">): string {
  const parts = [p.name];
  if (p.admin1) parts.push(p.admin1);
  else if (p.country_code) parts.push(p.country_code);
  return parts.join(", ");
}
