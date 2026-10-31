# v1 phase 2 — best window and outlook

Project Air phase 2 from the locked plan, on top of the week-1 store in [WEEK1.md](./WEEK1.md) and the phase-1 ingest in [WEEK2.md](./WEEK2.md). Both reads use `forecast_issued` only. Official AirNow rows are not an input. There is no new migration, no paid service, and no scheduler.

`ios/`, `design/`, `src/routes/`, and `src/components/` are untouched. Inversion, smoke, and ozone alert rules are the next slice.

## Best window

`bestWindowFromHours` in `src/lib/v1/phase2.ts`.

For one saved place, take the latest issue of each `valid_for` (`loadLatestHours`). The same issue instant keeps the later insert. Hours in `[asOf, asOf + 48 hours]` are the candidates. The length is `DAY12_MS` from `src/lib/v1/rules.ts`, the same cut as `classifyForecastLead`: the exact 48-hour instant is in, and one millisecond later is out. An hour before `asOf` is out.

The window is the lowest corrected AQI band in that set, then the longest run of those hours that are exactly one hour apart. A missing hour breaks the run. Nothing is filled in. Equal length keeps the earlier start. One stored hour is enough.

`start` is the first stored hour. `end` is one hour after the last stored hour, so a single hour is a one-hour span. `peakCorrectedAqi` is the highest corrected value inside the run. `sources` lists the forecast sources of those hours, in time order, once each. `band` is the EPA band of the peak (`good`, `moderate`, `usg`, `unhealthy`, `very`, `hazardous`). `very` is 201–300.

No candidate hour returns `bestWindow: "none"`. That includes a place with rows only after the 48-hour mark.

Bands are 0–50, 51–100, 101–150, 151–200, 201–300, and 301–500. Corrected forecast only. The official number is not read.

## Outlook

`outlookFromHours` in the same file.

`timeZone` is an IANA zone supplied by the caller. `saved_place` has no zone column, and this slice does not add one. Tomorrow is the next calendar day in that zone. The weekend is Saturday and Sunday. Monday through Friday look forward. On Saturday or Sunday, this weekend still includes the remaining day: Sunday's weekend is yesterday and today, not next week.

Each of those days is a summary of the stored hours whose `valid_for` falls on that local date, after the latest-issue pick. Hours that are not stored are not invented.

| Field                 | Meaning                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `worstCorrectedAqi`   | Highest corrected value that day.                                                                   |
| `typicalCorrectedAqi` | Median of the stored hours. An even count rounds the midpoint half up.                              |
| `band`                | EPA band of the worst value.                                                                        |
| `label`               | `valley` when every hour is days 1–2. `regional and low-confidence` when any hour is past 48 hours. |

The lead uses `classifyForecastLead` on that hour's own `issuedAt` and `validFor`. Days 1–2 keep `confidence: valley`, `spatialScale: valley`, `horizon: day_1_2_valley`. Anything past 48 hours, including a stored `noaa_aqf` row whose own confidence is `model`, is reported as `confidence: low`, `spatialScale: regional`, `horizon: day_3_7_regional_low_confidence`. A day with no stored hour is `summary: "no data"`.

## HTTP

Owner-scoped, same as the other place routes. Another user's id is `place_not_found`. GET only.

| Method | Path                             | Action                    |
| ------ | -------------------------------- | ------------------------- |
| GET    | `/api/v1/places/:id/best-window` | The window above          |
| GET    | `/api/v1/places/:id/outlook`     | Tomorrow and this weekend |

`asOf` is an optional UTC timestamp. Omitted, it is the request clock. `outlook` requires `timeZone`. The handler is `handleV1` in `src/lib/v1/http.ts`. The existing `/api/v1/$` route already forwards GET there.

## Checks

Fixture hours are `fixtures/v1/phase2-window.json`. `src/lib/v1/phase2.test.ts` runs on PGLite and covers the tie, the exact 48-hour boundary, the 50/51 band edge, the latest issue, an empty store, a day split across valley and regional hours, a weekend that starts on Saturday or Sunday, and an official 500 that does not change either read. The reads' SQL does not mention `official_`.

```bash
npm test
npm run lint
npm run typecheck
```

`npm test` stays on PGLite. It does not need `DATABASE_URL`, and it does not call NOAA or AirNow.

Dex reviews this head. Only Clint merges.
