import { forecastBodiesFromExtracts } from "./noaa.ts";
import { issueForecast } from "./store.ts";
import type { IssuedForecast, Queryable } from "./types.ts";

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
