# Product

Last updated: 2026-08-05

## One-liner

Personal **air quality watchlist** PWA: up to five places, live US AQI, hour/day forecasts, device-local save.

## Core UX

| Action | Behavior |
| --- | --- |
| Open app | Watchlist cards (seeded defaults until edited) |
| Tap card | Expands in place (full width on larger screens): advice, pollutants, forecast. Tap again to collapse. |
| **By hour** | Area chart of hourly US AQI for the forecast window |
| **By day** | Bar chart: one bar per day = **average** US AQI, band color, AQI on bar. Tap day/chip → hourly for that day. **All days** returns to bars. |
| Swipe left | Reveals **Delete** |
| Add place | Search or current location; max 5 |
| Refresh | Refetch all AQI queries |
| Install | PWA (manifest + service worker) |

### Branding

UI titles: **Air Quality** / **Watchlist** (no “Aether” in chrome). Host/project may still use `aether-aqi` for continuity.

## Data expectations

- On-device only (see [ARCHITECTURE.md](./ARCHITECTURE.md)).
- Daily values = average of Open-Meteo hourly US AQI per calendar day (`forecast_days=4`).

## Roadmap

### Phase 1 (shipped)

- [x] Multi-location watchlist (max 5)
- [x] Live US AQI + pollutants
- [x] Hourly forecast chart
- [x] Day bar chart with AQI labels + drill to that day’s hourly
- [x] PWA install shell
- [x] Device-local persistence
- [x] Debranded UI
- [x] Swipe card → Delete
- [x] Expand card for detail
- [x] Project docs in git (`docs/`)

### Phase 2 (planned)

- [ ] Swipe rail: notify when AQI exceeds a user-chosen threshold
  - Permission UX, per-location threshold, reliable delivery (push/SW for true background)
- [ ] Optional account-backed sync across devices
- [ ] Stronger offline last-known AQI

### Out of scope (for now)

- Multiplayer / social
- Claiming regulatory AirNow equivalence
- Native app stores (PWA only)

## Accessibility / mobile

- Usable at ~390px; no horizontal overflow on primary flows.
- Swipe locks horizontal only so vertical scroll still works.
- Forecast controls use `data-no-swipe`.
- Day chips under the bar chart are alternate hit targets for drill-down.
