# v1 phase 2 — smoke, inversion, and ozone alerts

Project Air phase 2 alert rules, on top of the forecast store in [WEEK1.md](./WEEK1.md) and the NOAA ingest in [WEEK2.md](./WEEK2.md). The best window and outlook stay in [PHASE2.md](./PHASE2.md).

`ios/`, `design/`, `src/routes/`, and `src/components/` are untouched. There is no push send, no subscription check, and no scheduler. Grid indexes are still not resolved here.

## Rules

Pure functions in `src/lib/v1/alerts.ts`: `smokeRule`, `inversionRule`, and `ozoneRule`. Each returns one decision: fired or not, `start` and `end`, severity, the source and confidence that drove it, a short reason, and `peakAqi`. A quiet rule has null start, end, severity, source, confidence, and `peakAqi`.

The stored series is replayed as hourly forecast time, not as a delay after the first bad hour. Three hours at or above the line start an episode. Three quiet hours end it. A single hour the other way does not start a second episode and does not clear the one that is already going. A missing hour is a quiet hour. The latest issue wins for one `validFor` and one pollutant. An unlabeled `noaa_smoke` hour and a PM2.5 label share that pollutant, and `O3` and `ozone` share one pollutant.

`start` is the first hour of the episode. `end` is exclusive: the first hour of the quiet run that cleared it, or one hour after the last hour still inside an open episode. Days 1-2 and days 3-7 do not share an episode. The cut is `classifyForecastLead`.

| Severity   | When                                                                             |
| ---------- | -------------------------------------------------------------------------------- |
| `elevated` | Days 1-2, peak AQI 101–150.                                                      |
| `high`     | Days 1-2, peak AQI 151 or higher.                                                |
| `heads_up` | Any days 3-7 episode. Confidence is `low` even when the stored row says `model`. |

Active means `start <= asOf < end`. Upcoming means `start` is still inside seven days of `asOf` (`DAY7_MS`). An episode that has already ended is left out. When both a days 1-2 episode and a days 3-7 episode are in play, the active one wins, and a days 1-2 episode wins if both are active.

`peakAqi` is the corrected peak that owned the episode, the same number the reason already quotes. The reason text does not change. Days 3-7 heads-up alerts carry that corrected peak too. An alert whose source is `airnow` has `peakAqi` null: AirNow promoted the episode, and the official number stays in the reason and in the AirNow panel. A forecast that was already on keeps the forecast source, so `peakAqi` stays the corrected peak even when the reason also cites a higher AirNow reading.

### Smoke

`smokeRule`. Hours whose pollutant is PM2.5, plus an unlabeled `noaa_smoke` hour. An ozone label is not smoke.

An hour is on at corrected AQI 101 or higher. Days 1-2 use the NOAA smoke model, source `noaa_smoke`, confidence `valley`. Days 3-7 use NOAA's air quality forecast or a regional row that is explicitly labeled PM2.5, and the decision is a heads up at low confidence. A regional row with no pollutant is not smoke.

The latest AirNow reading is an input. `official_reading.parameter` (`migrations/0008_v1_airnow_parameter.sql`) stores `PM2.5` or `O3` when AirNow's ParameterName is that name. PM10 and any other name are stored as null. Rows already stored stay null; there is no backfill. `readAlerts` passes the stored parameter, and null is `unknown`. Unknown does not choose smoke or ozone and does not change the threshold. A stored `PM2.5` promotes a days 1-2 hour that is already at or above 51 when AirNow is at or above 101, for the hour of the observation through six hours after, and the hour before it. Days 3-7 are not promoted. When the forecast was already on, the reason cites the AirNow number and the source stays the forecast. `peakAqi` is that corrected peak. When AirNow alone promoted the episode, the source is `airnow` and `peakAqi` is null.

### Ozone

`ozoneRule`. Pollutant `O3` or `ozone`. Local month in `timeZone` must be May through September. Outside that, the hour is quiet even if the number is high.

Days 1-2 fire as an alert. Source `noaa_aqf`, confidence `model`, unless AirNow ozone promoted the hour, in which case the source is `airnow` and confidence is `valley`. Days 3-7 are a heads up at low confidence. The same AirNow promotion rule applies, and only when the parameter is `O3`. A forecast ozone alert carries the corrected peak in `peakAqi`. An AirNow-promoted ozone alert leaves `peakAqi` null.

`forecast_issued` still refuses a days 1-2 `noaa_aqf` row (`day_1_2_valley_only` in `src/lib/v1/rules.ts`). This slice does not change that check. `ozoneRule` evaluates a days 1-2 ozone hour when the caller passes one. The read route can return a days 3-7 ozone heads up from a stored `noaa_aqf` row with pollutant `O3`. It still cannot store a days 1-2 `noaa_aqf` row. A days 1-2 hour the forecast already kept, labeled ozone, fires when that hour is at or above 101, and also when the stored AirNow parameter is `O3` and the promotion rule matches.

### Inversion

`inversionRule`. Winter is November through February in `timeZone`. Every hour needs a HRRR stability sample and a PM2.5 forecast at the same `validFor`.

| Input               | Threshold                                                                      |
| ------------------- | ------------------------------------------------------------------------------ |
| Mixing height       | At or under 400 m. HRRR `HPBL` at the surface, meters.                         |
| 10 m wind speed     | At or under 2 m/s. `hypot` of the mean `UGRD` and `VGRD` at 10 m above ground. |
| PM2.5 corrected AQI | At least 101, from the forecast hour at that `validFor`.                       |
| Month               | November, December, January, February.                                         |
| Persistence         | 3 hours on, 3 hours off.                                                       |

All of them have to hold. A clean stable night stays quiet. A windy day with elevated PM stays quiet here (smoke can still fire). A well-mixed hour stays quiet even when the wind is light and PM is high. A shallow mix in summer stays quiet. A one-hour or two-hour spike stays quiet.

The source on a fired inversion is `noaa_hrrr`. Days 1-2 confidence is `valley`. A days 3-7 PM hour paired with stability is a heads up at low confidence. The ingest below only keeps lead hours 0 through 48, so the rows it writes pair with days 1-2. The reason quotes mixing height from the hour with the peak corrected AQI. `peakAqi` is that corrected peak. Inversion is not an AirNow alert.

OpenDAP on `nomads.ncep.noaa.gov` was turned off on 23 February 2026 (Service Change Notice 25-81). A `.dds` request returns that notice, not a variable list. The live keyless file is `hrrr.tCCz.wrfsfcfHH.grib2` under `/pub/data/nccf/com/hrrr/prod/hrrr.YYYYMMDD/conus/`. The 12Z surface index for 2026-10-30 has `TMP:2 m above ground`, `UGRD` and `VGRD` at `10 m above ground`, and `HPBL:surface`. Wind is also stored at 80 m. Temperature is not. `WIND:10 m above ground` on that file is the day's maximum, so the filter does not request `var_WIND`.

`hrrrStabilityFilterUrls` builds `cgi-bin/filter_hrrr_2d.pl` for one lead hour at a time. The box is at most 0.2 degrees on a side. No API key is added. `stabilitySampleFromGrib` reads the filter's simple-packed GRIB2 and averages the cells (16 at most). Skin temperature (`TMP` on the ground surface) is ignored. `fetchNoaaGrib` is the live GET. `ingestRecordedStability` writes one decoded hour and does not open a socket. Tests use the recorded extracts and do not call NOAA.

`stability_issued` (`migrations/0003_v1_stability.sql`) stores the 2 m temperature in Kelvin, mixing height in meters, and the 10 m wind speed. `recordStability` writes one hour for the owner. There is no HTTP write and no launchd job. Phase 1 smoke and air-quality URL builders still name OpenDAP ASCII. This slice does not switch them.

## Replay

`fixtures/v1/inversion-replay.json` is the Dex gate. The hours are checked-in samples on either side of the thresholds, not a certified archive. `inversionRule` fires on the stagnant inverted morning and the deeper inverted afternoon. It stays quiet on the windy mixed day, the clean stable night, the well-mixed dirty afternoon, the summer shallow mix, and the two-hour spike. The hour-by-hour flip never fires, including when `asOf` steps through each hour. One clean hour inside a long inversion stays one episode and stays active through that hour.

`fixtures/v1/inversion-recorded.json` is the White Pine record (AQSID 160010017) for 1 December 2025 through 28 February 2026. HourlyAQObs at 07, 11, 15, and 19 MST stayed under 35.5 µg/m³. The highest screened hours were 1 January and 14 December at 30 µg/m³. The inversion days are 13–15 January 2026. Full-day peaks are 31, 37, and 38 µg/m³. 14 and 15 January are the days that crossed 35.5 µg/m³. Reported PM25_AQI on those peaks is 86, 94, and 98. The control days are 17 December 2025 (peak 7 µg/m³; reported PM25_AQI 21 at that hour and 24 an hour later) and 24 December 2025 (peak 3 µg/m³, reported PM25_AQI 28). 16 February peaked at 7 µg/m³ and was left out because 24 December was lower. HRRR on each chosen day is the f00 analysis on `noaa-hrrr-bdp-pds` at local hours 05–10 and 16–22. The file stores the `.idx` byte range for `TMP` at 2 m, `UGRD` and `VGRD` at 10 m, `HPBL` at the surface, and `MASSDEN` at 8 m. Each range is the full CONUS message. `boise` is the nearest Lambert cell, i 399, j 770, index 1385629.

`inversionRule` on those hours stays quiet on 13–15 January 2026 and on 17 and 24 December 2025. Thresholds were not changed. The miss on the inversion days is the PM term. Local 05–10 meets mixing height at or under 400 m and wind at or under 2 m/s on all three days, six hours in a row. 13 January local 17–22 does too. 14 January's evening window breaks at local 18, where the wind is 2.04 m/s, and local 16 is 431 m. 15 January meets both lines on all 13 sampled hours. Local 11 through 15 are not in the file, so a morning run and an evening run stay separate. MASSDEN at 8 m on the inversion days stays at or under 6.8e-11 kg/m³, and the corrected AQI is 0. 17 December reaches corrected AQI 2, and only local 21–22 meet both met lines. 24 December stays above both lines, mixing height at least 422 m and wind at least 3.7 m/s, with corrected AQI at most 1.

`fixtures/v1/noaa-hrrr-stability-f00.grib2` and `noaa-hrrr-stability-f06.grib2` are NOMADS filter extracts for a small box over Boise at the 2026-10-30 12Z cycle, lead 0 and lead 6. Lead 0 averages about 277.9 K at 2 m, mixing height about 44 m, and 10 m wind under 1 m/s. Copied onto a January hour, that met fires. Left on 30 October, it stays quiet because October is not winter.

## PM input options (for Jason)

`inversionRule` is unchanged. These four options are the PM term only, computed from `fixtures/v1/inversion-recorded.json`. The days are the three inversion days and the two controls in that file. Each day is the 13 HRRR hours at local 05–10 and 16–22. Local 11–15 are absent, so a morning run and an evening run stay separate. A missing AirNow hour is a quiet PM hour. Three hours on still start an episode, and three quiet hours still end it.

HRRR corrected AQI is the highest MASSDEN hour `inversionRule` already reads. On 13–15 January that hour is 0, and so is every other sampled hour. White Pine PM2.5 is the full-day hourly peak. Reported AQI is `PM25_AQI` on that peak hour, copied as reported, not recomputed from the µg/m³. 13 January local 05 is 11 µg/m³ and reported AQI 53.

| Local day   | Kind      | HRRR corrected AQI | PM2.5 µg/m³ | Reported AQI at that peak | Mixing height and wind                                      |
| ----------- | --------- | -----------------: | ----------: | ------------------------: | ----------------------------------------------------------- |
| 13 Jan 2026 | inversion |                  0 |          31 |                        86 | Yes. Local 05–10 and local 17–22.                           |
| 14 Jan 2026 | inversion |                  0 |          37 |                        94 | Yes. Local 05–10 and local 19–22.                           |
| 15 Jan 2026 | inversion |                  0 |          38 |                        98 | Yes. All 13 sampled hours.                                  |
| 17 Dec 2025 | control   |                  2 |           7 |                        21 | No. Only local 21–22, two hours.                            |
| 24 Dec 2025 | control   |                  1 |           3 |                        28 | No. Mixing height at least 422 m and wind at least 3.7 m/s. |

14 January local 16 is 431 m, and local 18 is 2.04 m/s, so local 17 is a one-hour met hour between those misses. 13 January local 16 is 403 m and 2.1 m/s. 17 December's reported AQI on the 7 µg/m³ hour is 21, and the highest reported AQI that day is 24 an hour later. 14 January's highest reported AQI is also 94, on the hour after the 37 µg/m³ peak.

(a) Today's rule. HRRR corrected AQI at 101, plus both met lines. Fires on none of the five days.

(b) Observed AirNow PM2.5 at AQI 101. Reported `PM25_AQI` replaces the HRRR number. The met lines stay. Fires on none of the five days. No hour reaches reported AQI 101. The highest is 98, on 15 January at local 03 (38 µg/m³), outside the HRRR hours. The highest on a sampled hour is 94.

(c) Observed AirNow PM2.5 at AQI 51 (Moderate). The same reported AQI, with the line at 51, and the met lines unchanged. Fires on 13, 14, and 15 January. Stays quiet on 17 and 24 December. 13 January starts at local 05 (reported AQI 53, 52, 52, 52) and again at local 17. Local 09 is 49, one quiet hour, which does not clear the morning. 14 January's morning does not hold 51 for 3 hours (55, 52, 49, 52, 48, 35). It starts at local 19 (80, 86, 94, 94). 15 January starts at local 05 and local 16. Every sampled hour that day is reported AQI 63 or higher.

(d) Meteorology only. No PM term. Fires on 13, 14, and 15 January. Stays quiet on 17 and 24 December. 13 January starts at local 05 and local 17. 14 January starts at local 05 and local 19. 15 January starts at local 05 and local 16. 17 December's two met hours are short of three.

None of the four options fires on a control day.

`tests/inversion-pm-options.test.ts` computes the four outcomes from the fixture. The helper is in that file. `src/lib/v1` is untouched.

## HTTP

Owner-scoped, same errors as the other place reads. Another user's id is `place_not_found`. GET only. POST is 405. A missing or unknown `timeZone` is 400 `invalid_time_zone`. `asOf` uses `parseAsOf`, so an impossible day such as `2026-02-30` is 400 `invalid_time`.

| Method | Path                        | Action                     |
| ------ | --------------------------- | -------------------------- |
| GET    | `/api/v1/places/:id/alerts` | Active and upcoming alerts |

Omitted `asOf` is the request clock. The body is `placeId`, `asOf`, `timeZone`, `through` (`asOf` plus seven days), and `alerts`. Quiet rules are omitted. An empty list means nothing is active or upcoming. Each alert includes `peakAqi`: a number for a forecast rule, null when `source` is `airnow`. The handler is `handleV1` in `src/lib/v1/http.ts`. The existing `/api/v1/$` route already forwards GET there.

## Checks

```bash
npm test
npm run lint
npm run typecheck
```

`npm test` stays on PGLite. It does not need `DATABASE_URL`, and it does not call NOAA or AirNow.

Dex reviews this head. Only Clint merges.
