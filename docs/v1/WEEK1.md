# v1 week 1 — forecast store and test push

ELT locked SharedBrain `v1-plan.md` on 2026-10-30. That lock is the week-1 scope. This branch implements the Keel column through the week-1 checkpoint: push delivery, saved places (up to 5), and a store that keeps each forecast next to what actually happened.

`keel/appstore-docs-k1` (#4) was not edited.

## Doc drift

These in-repo lines are stale. They stay where they are so the citations still match the files a reviewer already has.

| File | Line | What it still says | What the locked plan does |
| --- | --- | --- | --- |
| [../appstore/ROADMAP.md](../appstore/ROADMAP.md) | 34 | Data stack **OPEN**. Do not switch providers in that doc's work. | Launch forecasts are NOAA. Official readings are EPA AirNow. Open-Meteo is not a launch source. |
| `docs/appstore/IOS-PLAN.md` on #4 (`keel/appstore-docs-k1`), not in this branch | 50 | Remote push is not required for v1. | Week 1 builds the server delivery path. The sender in this branch is the in-process test sender. |

`IOS-PLAN.md` line 50, verbatim on #4: "Remote push is not required for v1."

The website `GET /api/aqi` and `GET /api/geocode` Open-Meteo proxies are unchanged. The on-device watchlist cap stays 15 (`src/lib/locations-store.ts`). The new server list is capped at 5.

## Data rules

- Days 1-2 (lead time through 48 hours): NOAA smoke model, valley scale (`source = noaa_smoke`, `spatial_scale = valley`, `confidence = valley`).
- Days 3-7 (after 48 hours, through 168 hours): NOAA's air quality forecast (`noaa_aqf`, regional, confidence `model`), or a row labeled regional and low-confidence (`regional` / `low`).
- EPA AirNow (free tier, 500 requests/hour when a later job is allowed to call it): the official number is stored unaltered, `preliminary = true`, with the AirNow credit. This branch does not add an AirNow key and does not call AirNow. Sample rows exercise the store.
- The corrected forecast and the official number are different columns in different tables. A second official write for the same place and time is rejected and the first number stays.
- Open-Meteo / CAMS is rejected with `open_meteo_not_for_launch`.
- PurpleAir spend is not approved. There is no PurpleAir client, host, or key. `ingestOutdoorSensors` and `applySensorGap` refuse outdoor samples (`purpleair_spend_not_approved`) and write nothing. A dropout (no outdoor PM) falls back to a NOAA valley forecast and writes `officialAqi: null`.
- The EPA linear correction (Barkjohn et al., Atmos. Meas. Tech., 2021: `0.524 * pmCf1 - 0.0852 * RH + 5.71`, pmCf1 0..250 µg/m³, RH 0..100) is tested on sample numbers. The ingest path does not call it, and it does not write either table.
- No new paid service, API key, or launchd job.

## Schema

Source: `migrations/0002_v1_forecast.sql`. Applied with the existing migrator (Neon on deploy, PGLite when `DATABASE_URL` is unset).

### `saved_place`

| Column | Meaning |
| --- | --- |
| `id`, `user_id` | Place id and owner. Queries are scoped to the signed-in user. |
| `name`, `latitude`, `longitude` | The saved place. Cap is 5 per user (app check and a `BEFORE INSERT` trigger). |
| `valley` | Optional valley name. Days 1-2 forecasts are valley scale even when this is empty. |
| `alert_at` | Optional threshold stored for later. Week 1 does not schedule alerts. |
| `position` | List order. |

### `forecast_issued` — corrected forecast only

There is no `official_aqi` column on this table.

| Column | Meaning |
| --- | --- |
| `place_id`, `user_id` | Owner and place. Composite foreign key to `saved_place`. |
| `source` | `noaa_smoke`, `noaa_aqf`, or `regional`. |
| `issued_at` | When this forecast was issued. |
| `valid_for` | The hour the forecast is for. |
| `horizon` | `day_1_2_valley`, `day_3_7_noaa_aqf`, or `day_3_7_regional_low_confidence`. |
| `spatial_scale` | `valley` or `regional`. |
| `confidence` | `valley`, `model`, or `low`. |
| `corrected_aqi` | The forecast number we publish. Integer 0..500. |
| `pollutant` | Optional short label. |

Check constraints tie source, horizon, scale, confidence, and the 0..168 hour window together. A raw `open-meteo` or `purpleair` insert fails `forecast_source_chk`.

### `official_reading` — official AirNow only

There is no `corrected_aqi` column on this table.

| Column | Meaning |
| --- | --- |
| `place_id`, `user_id` | Owner and place. |
| `source` | Always `airnow`. |
| `observed_at` | When the official reading applies. The side-by-side view pairs this to `forecast_issued.valid_for`. |
| `official_aqi` | Integer as reported. |
| `official_raw` | The exact integer token (`"48"` for 48). A mismatch is rejected as altered. |
| `preliminary` | Must be true. |
| `attribution` | AirNow credit. The app stores `AIRNOW_ATTRIBUTION` in `src/lib/v1/rules.ts`. |

Unique on `(place_id, observed_at)`. The second insert is refused; the stored number is not updated.

### `forecast_beside_observed`

A read-only view. It joins `forecast_issued` to `official_reading` on place, user, and `observed_at = valid_for`. Inserts go to the base tables.

### `push_device` and `push_delivery`

| Column | Meaning |
| --- | --- |
| `push_device.token` | Opaque test token. Not an Apple key. |
| `push_device.platform` | `test` only. |
| `push_delivery.payload` | JSON snapshot. `forecast.correctedAqi` and `official.aqi` are separate objects. |
| `push_delivery.sender` | `test` only. |
| `push_delivery.status` | `sent` or `failed`. |

## Push

`TestPushSender` (`src/lib/v1/push.ts`) keeps payloads in memory. It does not open a socket. `POST /api/v1/push/deliver` loads the side-by-side row, builds the payload, hands it to that sender, and writes `push_delivery`.

Sample envelopes, also on disk under `fixtures/v1/`:

- `push-day1.json` — Boise, corrected 155 (NOAA smoke, valley), official AirNow 48 preliminary.
- `push-day5.json` — NOAA air quality forecast 90, no official reading yet.
- `push-day6.json` — regional, low confidence, 80.

`node --experimental-strip-types scripts/push-test-sender.ts` sends those three through the test sender.

A sender whose name is not `test` is rejected (`push_sender_is_test_only`).

## HTTP

`src/routes/api/v1/$.ts` resolves the session with `requireUserId`, then `handleV1`. Paths:

| Method | Path | Action |
| --- | --- | --- |
| GET, POST | `/api/v1/places` | List or add a saved place |
| DELETE | `/api/v1/places/:id` | Remove one |
| GET, POST | `/api/v1/forecasts` | Side-by-side list, or issue a forecast |
| POST | `/api/v1/observations` | Store an official AirNow reading |
| GET | `/api/v1/push/samples` | The three sample payloads |
| POST | `/api/v1/push/devices` | Register a test device token |
| POST | `/api/v1/push/deliver` | Deliver one forecast to the user's test devices |

## Checkpoint

Push delivery and the forecast store are in this branch. `src/lib/v1/week1.test.ts` uses sample rows and checks that official 48 and corrected 155 stay on their own columns, including when a later forecast is issued, when a second official write is refused, and when a test push is sent or fails.

```bash
npm test
npm run lint
npm run typecheck
node --experimental-strip-types scripts/push-test-sender.ts
```

Dex reviews this head. Only Clint merges.
