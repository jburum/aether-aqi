# v1 phase 1 — NOAA and AirNow ingest

Project Air phase 1 from the locked SharedBrain `v1-plan.md`. This branch adds ingest on top of the week-1 store in [WEEK1.md](./WEEK1.md). Forecast rows and official readings go through `issueForecast` and `recordOfficial`. There is no new migration.

`ios/`, `design/`, `src/routes/index.tsx`, and `src/components/` are untouched.

## What landed

- NOAA HRRR-Smoke for lead 0 through 48 hours (`src/lib/v1/place-ingest.ts`, `fetchHrrrSmokeField`). The row is `source = noaa_smoke`, valley scale, valley confidence, horizon `day_1_2_valley`. The field is near-surface smoke mass density (`MASSDEN` at 8 m, kg/m³) from the public AWS GRIB. It becomes the corrected PM2.5 AQI through the 2024 EPA breakpoints in `src/lib/v1/pm25-aqi.ts`. `hrrrSmokeAsciiUrl` remains for the recorded ASCII parser.
- NOAA AQM surface PM2.5 for lead hours 49 through 72 (`src/lib/v1/place-ingest.ts`, `fetchAqmPm25Messages`). The row is `source = noaa_aqf`, regional scale, confidence `model`, horizon `day_3_7_noaa_aqf`. The file is the NOMADS prod GRIB `aqm.YYYYMMDD/CC/aqm.tCCz.ave_1hr_pm25_bc.227.grib2` (`CC` is 06 or 12), and `ave_1hr_pm25.227.grib2` in that same directory when the bias-corrected object is missing. Hours 73 through `FORECAST_HORIZON_HOURS` (168) have no source. They are returned as `unavailableHours` and are not stored. Nothing is copied forward from hour 72. A number is not invented.
- The cut is `classifyForecastLead` in `src/lib/v1/rules.ts`. Lead time `<= 48` hours, including that instant, is days 1-2. One millisecond later is days 3-7. A smoke value after 48 hours is not stored. An air-quality value at or before 48 hours is not stored.
- EPA AirNow current observations (`src/lib/v1/airnow.ts`). The reported integer is stored on `official_reading` with `preliminary = true` and `AIRNOW_ATTRIBUTION`. It does not go through the breakpoint function. A non-integer AQI is not rounded. A `correctedAqi` field on the payload is ignored. Category numbers are not the AQI.
- The key is the environment variable `AIRNOW_API_KEY`, documented in `.env.example`. No key is committed. When it is unset, `fetchAirNowObservation` returns `airnow_api_key_missing` and does not call out.
- Sensor dropout stays AirNow plus NOAA (`fallbackSensorDropout`). Outdoor PurpleAir is still `purpleair_spend_not_approved` and writes nothing. A dropout writes the lead-0 smoke forecast and, when AirNow has a reading, the official number on the other table. A missing key leaves `officialAqi` null and still writes the NOAA row.
- Parsers are tested against recorded samples: `fixtures/v1/noaa-hrrr-smoke.ascii`, `fixtures/v1/noaa-aqf.ascii`, and `fixtures/v1/airnow-current.json`. On that sample, smoke at hour 48 is corrected 155 and the AirNow row is official 48. The air-quality cell at hour 48 (which would be 181) is not stored. Hour 49 is the air-quality forecast (56). Hour 96 is inside hours 73 through 168, which are unavailable and are not stored.
- A repeat for the same place, source, issue time, and valid hour does not throw and does not upsert. The first corrected number stays. The place result and `POST /api/v1/ingest/run` count `stored`, `skipped`, and `conflicts` when the incoming corrected value differs. Official AirNow keeps the first integer the same way. `recordOfficial` still refuses a second direct write. See [INGEST.md](./INGEST.md).

## Data rules

- The corrected forecast and the official number stay in different tables. `forecast_issued` has `corrected_aqi` and no official column. `official_reading` has `official_aqi` and no corrected column. `forecast_beside_observed` only reads them side by side.
- Open-Meteo is still rejected (`open_meteo_not_for_launch`) before a request and before a row is written.
- PurpleAir spend is not approved. There is no PurpleAir host, key, or client.
- NOAA URLs are keyless. AQF stays on `https://nomads.ncep.noaa.gov`. HRRR smoke stays on `https://noaa-hrrr-bdp-pds.s3.amazonaws.com` with no query string. A credential query parameter is rejected.
- HRRR-Smoke: `hrrr.YYYYMMDD/conus/hrrr.tCCz.wrfsfcfHH.grib2` and its `.idx`. The range is the `MASSDEN:8 m above ground` message. Hours 0 through 48.
- Air quality model: `/dods/aqm/aqmYYYYMMDD/aqm.tCCz.ascii?pm25sfc[hour:hour][lat:lat][lon:lon]`.
- OpenDAP on NOMADS was turned off on 23 February 2026 (Service Change Notice 25-81). Place ingest does not call `/dods/hrrr/`. The recorded ASCII fixture is still what `parseHrrrSmoke` reads. Inversion ingest uses the GRIB filter; see [ALERTS.md](./ALERTS.md).
- Cycles used here are 00, 06, 12, and 18 UTC. The recorded ASCII is one grid cell, so both indexes on the data line are 0. Turning a latitude and longitude into those indexes is not in this branch.
- `NaN`, `-9999`, and values on the order of `1e20` are missing cells. They are not stored as AQI 500.
- The hourly model concentration uses the daily PM2.5 breakpoint table. NowCast weighting is not applied.
- AirNow's URL is `https://www.airnowapi.org/aq/observation/latLong/current/` with `format=application/json` and `distance=25`. The key is the `API_KEY` query parameter. Failures do not include the response body, so a key echoed by the server is not kept.
- When several pollutants share the latest hour, the stored official number is the highest integer AQI among them. That integer is stored as reported. It is not averaged with the forecast.
- Official rows stay preliminary and keep the AirNow credit. A second direct write for the same place and time is refused, and the first number stays. Place ingest reports that repeat as `skipped` or `conflicts` and does not change the row.
- No new paid service and no launchd job.

## What's left

- Resolving a saved place to HRRR and AQM grid indexes, then running the live fetch on a schedule. This branch does not add launchd or a Mini job.
- NowCast. Hours in the air-quality file that have no model cell and no explicit regional integer stay unstored.
- The AirNow key itself. The name is documented. The value is not in the repo.
- PurpleAir, until spend is approved.
- iOS and the website UI. `GET /api/aqi` is still the Open-Meteo proxy. It is not a launch source for these rows.

## Checks

```bash
npm test
npm run lint
npm run build
```

`npm test` stays on PGLite. It does not need `DATABASE_URL`, and it does not call NOAA or AirNow. Fetch functions take a `fetchImpl`. Fixture tests pass a fake one. The missing-key path does not call it.

Dex reviews this head. Only Clint merges.
