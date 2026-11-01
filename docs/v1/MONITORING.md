# v1 phase 4 — monitoring

Project Air phase 4 from the locked plan: a call ledger, budget checks, and feed health. This branch adds that on top of the week-1 store in [WEEK1.md](./WEEK1.md) and the phase-1 ingest in [WEEK2.md](./WEEK2.md). There is no scheduler, no launchd job, no new environment variable, and no paid call.

`ios/`, `design/`, `src/routes/`, and `src/components/` are untouched. PurpleAir stays off. The points figure is a projection. Nothing is purchased.

## Ledger

`upstream_call` in `migrations/0005_v1_monitoring.sql`, next to the forecast store. One row per outbound attempt.

| Column          | Meaning                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `source`        | `noaa`, `airnow`, or `purpleair`.                                                                                                    |
| `endpoint_kind` | `hrrr_smoke_ascii`, `aqf_ascii`, `hrrr_stability_grib`, `noaa_other`, `airnow_current`, `purpleair_sensors`, or `purpleair_history`. |
| `called_at`     | When the attempt left this process.                                                                                                  |
| `outcome`       | `ok` or `error`.                                                                                                                     |
| `error_code`    | A short token on errors. Null when the attempt is ok.                                                                                |
| `points`        | PurpleAir only. The points that attempt would cost. Null for NOAA and AirNow.                                                        |

The table has no URL, key, user, or place. Field names used to price a PurpleAir attempt are not stored.

`fetchNoaaAscii`, `fetchNoaaGrib`, and `fetchAirNowObservation` write a row when the caller passes the store. A URL that is refused before the request writes nothing. A missing `AIRNOW_API_KEY` writes nothing and does not call out. An AirNow hour that is already at 500 writes nothing and does not call out. `fallbackSensorDropout` passes the store for a live AirNow call. `ingestRecordedNoaa`, `ingestRecordedAirNow`, and `ingestRecordedStability` do not call out, so they write no ledger row.

A ledger insert or update that throws is logged and does not leave `fetchAirNowObservation`. `fallbackSensorDropout` still stores the NOAA forecast. The log line is the driver text. It has no key and no URL.

There is still no PurpleAir client. A PurpleAir ledger row exists only when a test, or a later caller, records one. Recording one does not open a socket.

## Budget

Pure functions in `src/lib/v1/monitoring.ts`.

AirNow stays under 500 requests an hour. The window is `(asOf - 1 hour, asOf]`. A call exactly one hour old is outside it. Ok and error rows both count. Warn at 400, which is 80% of 500. 399 is `ok`, 400 through 499 is `warn`, 500 and up is `over`. NOAA rows do not count toward this hour.

`airNowBudget` reports that hour. `reserveAirNowCall` enforces it. Before `fetchAirNowObservation` calls out, and only when a store was passed, one statement takes the advisory lock, reads `clock_timestamp()`, counts AirNow rows in `(that clock - 1 hour, that clock]`, and inserts the attempt at that same clock when the count is under 500. The caller does not supply the stamp. A stamp taken before the lock could reserve out of order and let the hour reach 501. `now()` is not the stamp: it is frozen at transaction start. Request 501 returns `airnow_hourly_limit` and does not call `fetch`. The inserted row is `error` / `airnow_reserved` until the attempt finishes, then `ok` or `error` / `airnow_fetch_failed`. A crash leaves the reservation, and it still counts. A call with no store is not reserved and not counted. The dropout path always passes the store. A reservation that throws returns `airnow_ledger_failed` and does not call out.

PurpleAir points follow the published points-per-field rule: add the point value of each requested field, then multiply by the number of rows returned. Rows are sensors on a sensor read, or history averages on a history read. A repeated field counts once.

The fields this check will price are `PURPLEAIR_FIELD_POINTS`. Each of them is 1 point. A field that is not in that table is `purpleair_points` and is not stored. The cost is not guessed.

The month is the points on PurpleAir rows inside `(asOf - 24 hours, asOf]`, scaled to 30 days with `Math.ceil`. A call exactly 24 hours old is outside the window. Ok and error rows both carry the points the request would have cost. With no PurpleAir rows the estimate is 0.

`enabled` and `spending` stay false. `status` stays `off`. A large estimate does not buy points and does not turn the client on.

## Feed health

Last successful ingest is the newest `created_at` in the store, not the ledger.

| Source    | Last success                                                          | Cadence                                                                             | Stale                                                                                    |
| --------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| NOAA      | Newest `forecast_issued.created_at` or `stability_issued.created_at`. | 6 hours. Cycles are 00, 06, 12, and 18 UTC.                                         | No row, or the newest row is more than 6 hours old. The exact 6-hour age is still fresh. |
| AirNow    | Newest `official_reading.created_at`.                                 | 1 hour.                                                                             | No row, or the newest row is more than 1 hour old.                                       |
| PurpleAir | None. There is no sensor table. A ledger row is not an ingest.        | 1 hour, the same hour as the official observation, used only as the dropout window. | Always, on this branch.                                                                  |

`created_at` is when the row was stored. `issued_at` is the model cycle and is not the freshness clock.

Dropout is PurpleAir only. A missing or stale PurpleAir success sets `dropout: true` and `fallback: ["airnow", "noaa"]`. That is the same fallback as `fallbackSensorDropout`: AirNow plus NOAA, and no sensor row. NOAA and AirNow can be stale without being a dropout. A PurpleAir success inside the hour would clear dropout. This branch never writes one, so `GET /api/v1/status` always reports the dropout.

Forecast-store freshness is per saved place: the newest `forecast_issued.created_at` for that place, against the 6-hour NOAA cadence. A place with no forecast is `missing`. A stored row at the exact cadence is `fresh`. One millisecond later is `stale`. A stability row refreshes the NOAA feed and does not make the forecast store fresh.

## HTTP

`GET /api/v1/status`. The handler is `readMonitoringStatus` via `handleV1`. The existing `/api/v1/$` route already forwards GET there, and it still requires a session before that. The body does not depend on which user is signed in.

Omitted `asOf` is the request clock. A bad `asOf`, including an impossible day such as `2026-02-30`, is 400 `invalid_time`. POST and DELETE are 405 `method_not_allowed`. The error JSON is `{ "error", "message" }`, the same shape as the other v1 routes.

The body is `asOf`, `feeds` (noaa, airnow, purpleair), `budget.airnow`, `budget.purpleair`, and `forecastStore`. Each feed has `lastSuccessAt`, `cadenceMs`, `ageMs`, `stale`, `dropout`, and `fallback`. The forecast list has one entry per saved place (`lastStoredAt`, `ageMs`, `fresh`) plus the counts. Place id, user id, name, valley, coordinates, AQI, attribution, keys, and URLs are not in the body.

## Checks

```bash
npm test
npm run lint
npm run typecheck
```

`npm test` stays on PGLite. It does not need `DATABASE_URL`. It does not call NOAA, AirNow, or PurpleAir. Stale, dropout, and over-budget cases are covered in `src/lib/v1/monitoring.test.ts`.

Dex reviews this head. Only Clint merges.
