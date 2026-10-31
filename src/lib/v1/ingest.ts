import {
  fetchAirNowObservation,
  officialInputFromAirNow,
  parseAirNowCurrent,
  airNowKey,
} from "./airnow.ts";
import { V1RuleError } from "./errors.ts";
import { forecastBodiesFromExtracts, lead0SmokeForecast } from "./noaa.ts";
import { planSensorGap, type SensorSample } from "./purpleair.ts";
import { applySensorGap, issueForecast, recordOfficial } from "./store.ts";
import type { IssuedForecast, OfficialReading, Queryable } from "./types.ts";

/**
 * Write one NOAA cycle from recorded ASCII. Days 1-2 are the smoke model.
 * Days 3-7 are AQF, or regional and low-confidence when that cell is empty.
 * This path does not open a socket. Live fetches go through `fetchNoaaAscii`.
 */
export async function ingestRecordedNoaa(
  sql: Queryable,
  userId: string,
  input: {
    placeId: string;
    issuedAt: string;
    smokeAscii: string;
    aqfAscii: string;
  },
): Promise<IssuedForecast[]> {
  const bodies = forecastBodiesFromExtracts(input);
  const stored: IssuedForecast[] = [];
  for (const body of bodies) {
    stored.push(await issueForecast(sql, userId, body));
  }
  return stored;
}

/** Store one recorded AirNow payload. The integer AQI is written as reported. */
export async function ingestRecordedAirNow(
  sql: Queryable,
  userId: string,
  placeId: string,
  body: string,
): Promise<OfficialReading> {
  const parsed = parseAirNowCurrent(body);
  if (!parsed.ok) throw new V1RuleError(parsed.code, parsed.message);
  return recordOfficial(sql, userId, officialInputFromAirNow(placeId, parsed.reading));
}

export interface SensorDropoutResult {
  action: "fall_back_to_airnow_and_noaa";
  forecast: IssuedForecast;
  officialAqi: number | null;
  airnowError: string | null;
}

/**
 * Outdoor PurpleAir is refused and nothing is written. A dropout writes the
 * lead-0 NOAA smoke forecast and, when AirNow has a reading, the official number
 * on its own table. A missing `AIRNOW_API_KEY` skips AirNow and does not call out.
 */
export async function fallbackSensorDropout(
  sql: Queryable,
  userId: string,
  input: {
    samples: readonly SensorSample[];
    placeId: string;
    issuedAt: string;
    smokeAscii: string;
    airnowBody?: string;
    point?: { latitude: number; longitude: number };
    fetchImpl?: typeof fetch;
  },
): Promise<SensorDropoutResult> {
  if (planSensorGap(input.samples).action === "purpleair_blocked") {
    throw new V1RuleError(
      "purpleair_spend_not_approved",
      "PurpleAir is out this week. Spend is not approved, and this path does not buy points or store sensor readings.",
    );
  }
  const forecastBody = lead0SmokeForecast(input.placeId, input.issuedAt, input.smokeAscii);
  let officialBody: unknown;
  let airnowError: string | null = null;
  if (input.airnowBody !== undefined) {
    const parsed = parseAirNowCurrent(input.airnowBody);
    if (!parsed.ok) {
      if (parsed.code === "airnow_parse") throw new V1RuleError(parsed.code, parsed.message);
      airnowError = parsed.code;
    } else {
      officialBody = officialInputFromAirNow(input.placeId, parsed.reading);
    }
  } else if (!airNowKey()) {
    airnowError = "airnow_api_key_missing";
  } else if (!input.point || !input.fetchImpl) {
    throw new V1RuleError("airnow_point_required", "AirNow ingest needs a latitude and longitude.");
  } else {
    const parsed = await fetchAirNowObservation(input.point, input.fetchImpl);
    if (!parsed.ok) airnowError = parsed.code;
    else officialBody = officialInputFromAirNow(input.placeId, parsed.reading);
  }
  const gap = await applySensorGap(sql, userId, input.samples, forecastBody, officialBody);
  return {
    action: "fall_back_to_airnow_and_noaa",
    forecast: gap.forecast,
    officialAqi: gap.officialAqi,
    airnowError,
  };
}
