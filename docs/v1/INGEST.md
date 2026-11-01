# v1 place ingest

Saved places can be ingested for one NOAA cycle. This is the manual run behind the week-2 note in [WEEK2.md](./WEEK2.md): a latitude and longitude become HRRR-Smoke and AQM cell indexes, then smoke, the air quality forecast, and AirNow go through the week-1 store. There is no scheduler, no launchd job, no new migration, and no new environment variable.

`ios/`, `design/`, `src/routes/`, and `src/components/` are untouched. The route file already forwards every `/api/v1` POST through the session check. PurpleAir stays off. OpenDAP on NOMADS has been off since Service Change Notice 25-81. HRRR smoke for lead 0 through 48 reads the public AWS bucket `noaa-hrrr-bdp-pds`: the `.idx`, then a byte-range GET of `MASSDEN` at 8 m. The stored value is the Lambert point nearest the saved place, not the GrADS cell center and not that cell's GrADS index. AQM hours 49 through 72 read the NOMADS prod GRIB `aqm.tCCz.ave_1hr_pm25_bc.227.grib2`, and `ave_1hr_pm25.227.grib2` when the bias-corrected object is missing. Hours 73 through `FORECAST_HORIZON_HOURS` (168) have no source. Tests pass a `fetchImpl` and replay `fixtures/v1`. They do not call NOAA or AirNow.

## Grid

`resolveModelCells` in `src/lib/v1/grid.ts`.

The live reads do not send these indexes. This is the GrADS linear axis those OpenDAP indexes used (`grads_mapping` linear, `grads_size` as the count, minimum as the origin, maximum as the end), not the Lambert i,j of the GRIB file. `hrrrSmokeCellCenter` is the center of that retired cell. HRRR smoke and AQM PM2.5 both pass the saved place latitude and longitude straight to the Lambert lookup. The `hrrr` and `aqm` indexes are still resolved and returned. Stability ingest still uses the GRIB filter box and is not part of this run.

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
2. HRRR-Smoke `MASSDEN` at 8 m, one object per lead hour from 0 through 48: `hrrr.tCCz.wrfsfcfHH.grib2` on `noaa-hrrr-bdp-pds`. The run reads the `.idx`, then `Range` for that message. A 404 skips the hour. The field is template 5.3 (complex packing, order-2 spatial differencing) on the Lambert grid.
3. AQM surface PM2.5 for lead hours 49 through 72. The cycle is the latest of 06Z and 12Z at or before the ingest cycle: 00Z uses the previous day's 12Z, and 18Z uses that day's 12Z. The bias-corrected object is `aqm.tCCz.ave_1hr_pm25_bc.227.grib2`. A 404 on that object falls back to `ave_1hr_pm25.227.grib2`. There is no `.idx`. The run walks GRIB section lengths with `Range` and downloads a message only when its valid time is inside that window. The field is product template 4.8. The valid hour is the interval end. An applied bitmap maps the Lambert cell to the packed index. A masked point is not stored and is not AQI 0. A failed fetch, or a body that does not parse, does not drop the smoke hours already decoded and does not skip step 5. `aqfError` is that code. No air-quality row is written from the failed body.
4. Hours 73 through `FORECAST_HORIZON_HOURS` in `src/lib/v1/rules.ts` have no source. That constant is 168. They are returned as `unavailableHours` and are not stored. Nothing is copied forward from hour 72. `forecastBodiesFromHours`, then `issueForecast`, writes the smoke hours and the AQM hours that decoded. A smoke value after 48 hours is not stored. An air-quality value at or before 48 hours is not stored. On the recorded fixtures, hour 48 smoke is corrected 155, hour 49 AQM is 56, and hour 72 AQM is 101. The air-quality cell at hour 48 is not stored.
5. AirNow current observation for the place, through `fetchAirNowObservation`. This still runs when step 3 failed.

Another user's places are not read and not written.

## Idempotency

The forecast unique key is `(place_id, source, issued_at, valid_for)`. A second run that produces the same key stores nothing and does not change `corrected_aqi`. A hotter smoke file on the repeat is ignored. The first number stays.

`official_reading` is unique on `(place_id, observed_at)` (`official_hour_unique`). `recordOfficial` already refuses a second write when it can see the row (`official_already_recorded`). Two overlapping runs can both pass that check. The loser then raises SQLSTATE 23505 on `official_hour_unique`. This run catches that constraint, reads the stored integer back, and returns it as `unchanged`. A later AirNow payload with a different AQI for that same hour does not overwrite it. A 23505 on any other constraint still fails the run.

A repeat still calls NOAA, and it calls AirNow when the key is set and the hour is under the ceiling. Those attempts are new ledger rows. The forecast and official tables are the no-op.

## Budget

Each HRRR hour is an index GET and, when the object is there, a byte-range GET, both through `fetchHrrrSmokeField`. AQM is ranged reads of one prod file through `fetchAqmPm25Messages`: a 16-byte open, then section lengths, then a full message only for hours 49 through 72. The same 206, Content-Range, and exact-length checks used for HRRR apply, and a message over 8 MiB is refused. The phase-4 ledger records `hrrr_smoke_ascii` for smoke and `noaa_other` for `/com/aqm/prod/`. A smoke cycle that finds hours 0, 24, and 48 is 46 missing index rows plus 6 successful smoke rows. The two-message AQM fixture adds 4 `noaa_other` rows. A URL refused before the request writes nothing. OpenDAP `/dods/hrrr/` and `/dods/aqm/` are not requested.

AirNow goes through `fetchAirNowObservation` with the same store. `reserveAirNowCall` counts the open hour and inserts the attempt only when the count is under 500. At 500 the result is `airnow_hourly_limit`, the client does not call, and no new AirNow ledger row is written. NOAA rows from that same run stay. NOAA does not count toward the 500.

`AIRNOW_API_KEY` unset returns `airnow_api_key_missing`. That path does not call and does not write a ledger row. The smoke and air-quality rows are still stored. No key is committed. The ledger row has no URL, key, user, or place.

PurpleAir is not a client on this path. There is no PurpleAir host, key, or call.

## HTTP

`POST /api/v1/ingest/run`. The handler is `ingestSavedPlaces` via `handleV1`. The existing `/api/v1/$` route requires a session before that. The error JSON is `{ "error", "message" }`, the same shape as the other v1 routes.

| Method | Path                 | Action                                 |
| ------ | -------------------- | -------------------------------------- |
| POST   | `/api/v1/ingest/run` | Ingest every saved place for one cycle |

The body is optional. `{}` and an empty body use the latest cycle. `cycleUtc` must be one of the four UTC hours. A bad cycle is 400 `noaa_cycle` or `invalid_time`, and nothing is fetched. GET is 405 `method_not_allowed`. A place outside the grid is 400 `outside_model_coverage`.

The 200 body is `cycleUtc` and `places`. Each place has `placeId`, `hrrr`, `aqm`, `forecastsStored`, `forecastsUnchanged`, `officialAqi`, `officialStatus` (`stored`, `unchanged`, or `skipped`), `aqfError`, `airnowError`, and `unavailableHours`. `aqfError` is null when the AQM file was read. `unavailableHours` is every lead after 72 through `FORECAST_HORIZON_HOURS`, including 168. `officialAqi` is null when this run did not take an official number. A skipped AirNow call does not delete an official row already stored. An AQM failure does not delete smoke rows stored on that same run.

## Checks

```bash
npm test
npm run lint
npm run typecheck
```

`npm test` stays on PGLite. It does not need `DATABASE_URL`. It does not call NOAA or AirNow. `src/lib/v1/grid.test.ts` covers Boise, McCall, and Tamarack, the halfway split, and points outside the grids. `src/lib/v1/grib.test.ts` covers the template 4.8 interval end and the bitmap on `fixtures/v1/noaa-aqm-pm25-4.8.grib2`. A masked point is null, not 0. `src/lib/v1/place-ingest.test.ts` covers the 48-hour cut, hours 49 and 72 from that AQM shape, hours 73 through 168 left unavailable, the bias-corrected file falling back to the raw file without downloading the message after hour 72, the AWS index fixture `fixtures/v1/noaa-hrrr-smoke-f00.grib2`, the recorded 2026-10-31 18Z MASSDEN message `fixtures/v1/noaa-hrrr-massden-8m.grib2`, a re-ingest that does not change the forecast or the official number, two overlapping runs that collide on `official_hour_unique`, the missing AirNow key, the hour at 500, and a non-GRIB AQM body (`fixtures/v1/noaa-aqf-retired.txt`) that still stores smoke and still calls AirNow.

Dex reviews this head. Only Clint merges.
