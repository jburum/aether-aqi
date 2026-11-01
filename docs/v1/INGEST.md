# v1 place ingest

Saved places can be ingested for one NOAA cycle. This is the manual run behind the week-2 note in [WEEK2.md](./WEEK2.md): a latitude and longitude become HRRR-Smoke and AQM cell indexes, then smoke, the air quality forecast, and AirNow go through the week-1 store. There is no scheduler, no launchd job, no new migration, and no new environment variable.

`ios/`, `design/`, `src/routes/`, and `src/components/` are untouched. The route file already forwards every `/api/v1` POST through the session check. PurpleAir stays off. OpenDAP on NOMADS has been off since Service Change Notice 25-81. A DAS request for 20 February 2026 (`hrrr_sfc.t12z` and `aqm.t12z`) returns that retirement page, not an axis, so this branch does not read a live axis. Tests pass a `fetchImpl` and do not call NOAA or AirNow.

## Grid

`resolveModelCells` in `src/lib/v1/grid.ts`.

The indexes are the ones `hrrrSmokeAsciiUrl` and `aqfAsciiUrl` already put in the query. Those URL builders are unchanged. This is the GrADS linear axis those OpenDAP indexes used (`grads_mapping` linear, `grads_size` as the count, minimum as the origin, maximum as the end), not the Lambert i,j of the GRIB file. Stability ingest still uses the GRIB filter box and is not part of this run.

Spacing is `(end - origin) / (count - 1)` degrees. Cell centers:

| Grid       | Axis      | Count | Origin       | End          | Spacing    |
| ---------- | --------- | ----: | ------------ | ------------ | ---------- |
| HRRR-Smoke | latitude  |  1059 | 21.138123°N  | 52.615654°N  | ~0.029752° |
| HRRR-Smoke | longitude |  1799 | 225.904526°E | 299.082809°E | ~0.040700° |
| AQM        | latitude  |   265 | 21.821°N     | 53.501°N     | 0.12°      |
| AQM        | longitude |   442 | 226.541°E    | 292.691°E    | 0.15°      |

HRRR-Smoke uses the `hrrr_sfc` dimensions, 1059 by 1799. AQM uses the NAQFC CONUS dimensions, 265 by 442. A saved place stores longitude from -180 through 180. Negative longitudes are shifted by 360 before the degrees-east axis. The nearest center wins. An exact halfway split rounds to the greater index, north or east. A point whose nearest center falls off either axis throws `outside_model_coverage` (`V1RuleError`). Nothing is fetched.

Coordinates below are the Idaho place list. McCall at -116.098° on the website watchlist is the same cell as -116.099°.

| Place    | Latitude | Longitude | HRRR lat | HRRR lon | AQM lat | AQM lon |
| -------- | -------: | --------: | -------: | -------: | ------: | ------: |
| Boise    |   43.615 |  -116.202 |      755 |      440 |     182 |     115 |
| McCall   |   44.911 |  -116.099 |      799 |      442 |     192 |     116 |
| Tamarack |   44.671 |  -116.117 |      791 |      442 |     190 |     116 |

## Cycle

`ingestPlaceCycle` in `src/lib/v1/place-ingest.ts`.

Cycles are 00, 06, 12, and 18 UTC, the same hours `noaaCycleParts` already accepts. The body may pass `cycleUtc`. Omitted, or an empty body, the cycle is the latest of those hours at or before the request clock. 05:59 UTC is still the 00 UTC cycle. 06:00 UTC is the 06 UTC cycle. The run does not wait for NOMADS to publish that cycle.

For each saved place of the signed-in user:

1. Resolve both cells. If any saved place is outside either grid, the run stops before any request. Earlier places are not fetched.
2. HRRR-Smoke `masden8m` for lead hours 0 through 48, including 48.
3. AQM `pm25sfc` for lead hours 49 through 168, including 168.
4. `forecastBodiesFromExtracts`, then `issueForecast`. A smoke value after 48 hours is not stored. An air-quality value at or before 48 hours is not stored. On the recorded fixtures, hour 48 smoke is corrected 155, hour 49 is the air quality forecast at 56, and hour 96 is regional low confidence at 80. The air-quality cell at hour 48 is not stored.
5. AirNow current observation for the place, through `fetchAirNowObservation`.

Another user's places are not read and not written.

## Idempotency

The forecast unique key is `(place_id, source, issued_at, valid_for)`. A second run that produces the same key stores nothing and does not change `corrected_aqi`. A hotter smoke file on the repeat is ignored. The first number stays.

`official_reading` is unique on `(place_id, observed_at)` (`official_hour_unique`). `recordOfficial` already refuses a second write when it can see the row (`official_already_recorded`). Two overlapping runs can both pass that check. The loser then raises SQLSTATE 23505 on `official_hour_unique`. This run catches that constraint, reads the stored integer back, and returns it as `unchanged`. A later AirNow payload with a different AQI for that same hour does not overwrite it. A 23505 on any other constraint still fails the run.

A repeat still calls NOAA, and it calls AirNow when the key is set and the hour is under the ceiling. Those attempts are new ledger rows. The forecast and official tables are the no-op.

## Budget

Every NOAA attempt goes through `fetchNoaaAscii` with the store, so the phase-4 ledger records `hrrr_smoke_ascii` and `aqf_ascii`. A URL refused before the request writes nothing.

AirNow goes through `fetchAirNowObservation` with the same store. `reserveAirNowCall` counts the open hour and inserts the attempt only when the count is under 500. At 500 the result is `airnow_hourly_limit`, the client does not call, and no new AirNow ledger row is written. NOAA rows from that same run stay. NOAA does not count toward the 500.

`AIRNOW_API_KEY` unset returns `airnow_api_key_missing`. That path does not call and does not write a ledger row. The smoke and air-quality rows are still stored. No key is committed. The ledger row has no URL, key, user, or place.

PurpleAir is not a client on this path. There is no PurpleAir host, key, or call.

## HTTP

`POST /api/v1/ingest/run`. The handler is `ingestSavedPlaces` via `handleV1`. The existing `/api/v1/$` route requires a session before that. The error JSON is `{ "error", "message" }`, the same shape as the other v1 routes.

| Method | Path                 | Action                                 |
| ------ | -------------------- | -------------------------------------- |
| POST   | `/api/v1/ingest/run` | Ingest every saved place for one cycle |

The body is optional. `{}` and an empty body use the latest cycle. `cycleUtc` must be one of the four UTC hours. A bad cycle is 400 `noaa_cycle` or `invalid_time`, and nothing is fetched. GET is 405 `method_not_allowed`. A place outside the grid is 400 `outside_model_coverage`.

The 200 body is `cycleUtc` and `places`. Each place has `placeId`, `hrrr`, `aqm`, `forecastsStored`, `forecastsUnchanged`, `officialAqi`, `officialStatus` (`stored`, `unchanged`, or `skipped`), and `airnowError`. `officialAqi` is null when this run did not take an official number. A skipped AirNow call does not delete an official row already stored.

## Checks

```bash
npm test
npm run lint
npm run typecheck
```

`npm test` stays on PGLite. It does not need `DATABASE_URL`. It does not call NOAA or AirNow. `src/lib/v1/grid.test.ts` covers Boise, McCall, and Tamarack, the halfway split, and points outside the grids. `src/lib/v1/place-ingest.test.ts` covers the 48-hour cut, a re-ingest that does not change the forecast or the official number, two overlapping runs that collide on `official_hour_unique`, the missing AirNow key, and the hour at 500.

Dex reviews this head. Only Clint merges.
