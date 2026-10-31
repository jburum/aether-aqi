# v1 phase 2 — smoke, inversion, and ozone alerts

Project Air phase 2 alert rules, on top of the forecast store in [WEEK1.md](./WEEK1.md) and the NOAA ingest in [WEEK2.md](./WEEK2.md). The best window and outlook stay in [PHASE2.md](./PHASE2.md).

`ios/`, `design/`, `src/routes/`, and `src/components/` are untouched. There is no push send, no subscription check, and no scheduler. Grid indexes are still not resolved here.

## Rules

Pure functions in `src/lib/v1/alerts.ts`: `smokeRule`, `inversionRule`, and `ozoneRule`. Each returns one decision: fired or not, `start` and `end`, severity, the source and confidence that drove it, and a short reason. A quiet rule has null start, end, severity, source, and confidence.

The stored series is replayed as hourly forecast time, not as a delay after the first bad hour. Three hours at or above the line start an episode. Three quiet hours end it. A single hour the other way does not start a second episode and does not clear the one that is already going. A missing hour is a quiet hour. The latest issue wins when the same `validFor` is stored twice.

`start` is the first hour of the episode. `end` is exclusive: the first hour of the quiet run that cleared it, or one hour after the last hour still inside an open episode. Days 1-2 and days 3-7 do not share an episode. The cut is `classifyForecastLead`.

| Severity   | When                                                                             |
| ---------- | -------------------------------------------------------------------------------- |
| `elevated` | Days 1-2, peak AQI 101–150.                                                      |
| `high`     | Days 1-2, peak AQI 151 or higher.                                                |
| `heads_up` | Any days 3-7 episode. Confidence is `low` even when the stored row says `model`. |

Active means `start <= asOf < end`. Upcoming means `start` is still inside seven days of `asOf` (`DAY7_MS`). An episode that has already ended is left out. When both a days 1-2 episode and a days 3-7 episode are in play, the active one wins, and a days 1-2 episode wins if both are active.

### Smoke

`smokeRule`. Hours whose pollutant is PM2.5, plus an unlabeled `noaa_smoke` hour. An ozone label is not smoke.

An hour is on at corrected AQI 101 or higher. Days 1-2 use the NOAA smoke model, source `noaa_smoke`, confidence `valley`. Days 3-7 use NOAA's air quality forecast or a regional row that is explicitly labeled PM2.5, and the decision is a heads up at low confidence. A regional row with no pollutant is not smoke.

The latest AirNow reading is an input. The store does not keep the pollutant, so `readAlerts` passes `parameter: "unknown"`. Unknown does not choose smoke or ozone and does not change the threshold. A caller that passes `PM2.5` can promote a days 1-2 hour that is already at or above 51 when AirNow is at or above 101, for the hour of the observation through six hours after, and the hour before it. Days 3-7 are not promoted. When the forecast was already on, the reason cites the AirNow number and the source stays the forecast.

### Ozone

`ozoneRule`. Pollutant `O3` or `ozone`. Local month in `timeZone` must be May through September. Outside that, the hour is quiet even if the number is high.

Days 1-2 fire as an alert. Source `noaa_aqf`, confidence `model`, unless AirNow ozone promoted the hour, in which case the source is `airnow` and confidence is `valley`. Days 3-7 are a heads up at low confidence. The same AirNow promotion rule applies, and only when the parameter is `O3`.

`forecast_issued` still refuses a days 1-2 `noaa_aqf` row (`day_1_2_valley_only` in `src/lib/v1/rules.ts`). This slice does not change that check. `ozoneRule` evaluates a days 1-2 ozone hour when the caller passes one. The read route can return a days 3-7 ozone heads up from a stored `noaa_aqf` row with pollutant `O3`. It cannot return a days 1-2 ozone alert until a later slice can store that row.

### Inversion

`inversionRule`. Winter is November through February in `timeZone`. Every hour needs a HRRR stability sample and a PM2.5 forecast at the same `validFor`.

| Input               | Threshold                                                                   |
| ------------------- | --------------------------------------------------------------------------- |
| `tmp80mK - tmp2mK`  | At least 1 K. HRRR temperature is Kelvin. The difference is the same in °C. |
| 10 m wind speed     | At or under 2 m/s. Speed is `hypot(u, v)` from `ugrd10m` and `vgrd10m`.     |
| PM2.5 corrected AQI | At least 101, from the forecast hour at that `validFor`.                    |
| Month               | November, December, January, February.                                      |
| Persistence         | 3 hours on, 3 hours off.                                                    |

All four have to hold. A clean stable night stays quiet. A windy day with elevated PM stays quiet here (smoke can still fire). A one-hour or two-hour spike stays quiet.

The source on a fired inversion is `noaa_hrrr`. Days 1-2 confidence is `valley`. A days 3-7 PM hour paired with stability is a heads up at low confidence. The ingest below only keeps lead hours 0 through 48, so the rows it writes pair with days 1-2.

Stability ASCII is keyless NOMADS, same host rule as smoke (`assertNoaaUrl`). The surface file is `hrrr_sfc`, variables `tmp2m`, `tmp80m`, `ugrd10m`, and `vgrd10m`. That is the same short-name pattern as `masden8m`. This branch does not call NOMADS. `stabilitySamplesFromExtracts` drops an hour with a fill (`1e20`, `-9999`), a missing component, or a lead past 48 hours. Turning a place into grid indexes is still not done.

`stability_issued` (`migrations/0003_v1_stability.sql`) stores Kelvin temperatures and the wind speed. `recordStability` writes one hour for the owner. There is no HTTP write and no launchd job.

## Replay

`fixtures/v1/inversion-replay.json` is the Dex gate. `inversionRule` fires on the stagnant inverted morning and the deeper inverted afternoon. It stays quiet on the windy mixed day (PM is elevated, the layer is not), the clean stable night (the layer is inverted, PM is not), and the two-hour spike. The hour-by-hour flip never fires, including when `asOf` steps through each hour. One clean hour inside a long inversion stays one episode and stays active through that hour.

`fixtures/v1/noaa-hrrr-stability.json` is the recorded ASCII for the parser. Hour 1 is a fill and is dropped. Hour 49 is past 48 hours and is dropped. Hour 0 and hour 48 stay.

## HTTP

Owner-scoped, same errors as the other place reads. Another user's id is `place_not_found`. GET only. POST is 405. A missing or unknown `timeZone` is 400 `invalid_time_zone`. `asOf` uses `parseAsOf`, so an impossible day such as `2026-02-30` is 400 `invalid_time`.

| Method | Path                        | Action                     |
| ------ | --------------------------- | -------------------------- |
| GET    | `/api/v1/places/:id/alerts` | Active and upcoming alerts |

Omitted `asOf` is the request clock. The body is `placeId`, `asOf`, `timeZone`, `through` (`asOf` plus seven days), and `alerts`. Quiet rules are omitted. An empty list means nothing is active or upcoming. The handler is `handleV1` in `src/lib/v1/http.ts`. The existing `/api/v1/$` route already forwards GET there.

## Checks

```bash
npm test
npm run lint
npm run typecheck
```

`npm test` stays on PGLite. It does not need `DATABASE_URL`, and it does not call NOAA or AirNow.

Dex reviews this head. Only Clint merges.
