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

export async function searchPlaces(query: string): Promise<GeoResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", q);
  url.searchParams.set("count", "8");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("Place search failed");
  const data = (await res.json()) as { results?: GeoResult[] };
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

export async function fetchAirQuality(lat: number, lon: number): Promise<AirQualityPayload & { mainPollutant: string }> {
  const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set(
    "current",
    "us_aqi,pm2_5,pm10,ozone,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide",
  );
  url.searchParams.set("hourly", "us_aqi,pm2_5,ozone");
  url.searchParams.set("forecast_days", "4");
  url.searchParams.set("timezone", "auto");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("Air quality fetch failed");
  const data = (await res.json()) as AirQualityPayload;
  return { ...data, mainPollutant: primaryPollutant(data.current) };
}

export function placeLabel(p: Pick<GeoResult, "name" | "admin1" | "country_code">): string {
  const parts = [p.name];
  if (p.admin1) parts.push(p.admin1);
  else if (p.country_code) parts.push(p.country_code);
  return parts.join(", ");
}
