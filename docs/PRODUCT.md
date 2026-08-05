# Product

Last updated: 2026-08-05

## One-liner

Personal **air quality watchlist** PWA: up to five places, live US AQI, hour/day forecasts, device-local save. Installable to the **iPhone Home Screen**.

## Core UX

| Action | Behavior |
| --- | --- |
| Open app | Watchlist cards (seeded defaults until edited) |
| Tap card | Expands in place: advice, pollutants, forecast. Tap again to collapse. |
| **By hour** | Area chart of hourly US AQI |
| **By day** | Bar chart of daily average US AQI; tap day → hourly for that day |
| Swipe left | Reveals **Delete** |
| Add place | Search or current location; max 5 |
| Refresh | Refetch all AQI queries |
| **Install (iPhone)** | Safari → Share → **Add to Home Screen** → opens standalone with app icon |

### Branding & icon

- UI titles: **Air Quality** / **Watchlist**
- App icon: dark tile with large **AQI number** and a green **line-chart** curve (`public/icon-*.png`, `apple-touch-icon.png`)
- Home screen short name: **Air Quality**

## Data expectations

- On-device only (see [ARCHITECTURE.md](./ARCHITECTURE.md)).
- Daily values = average of Open-Meteo hourly US AQI per calendar day.

## Roadmap

### Phase 1 (shipped)

- [x] Multi-location watchlist (max 5)
- [x] Live US AQI + pollutants
- [x] Hourly + day bar + day→hourly drill-down
- [x] PWA + iOS Home Screen install (meta, manifest, apple-touch-icon)
- [x] Custom AQI chart app icon
- [x] Device-local persistence
- [x] Swipe delete, expand cards
- [x] Docs in git

### Phase 2 (planned)

- [ ] Swipe rail: notify when AQI exceeds a user-chosen threshold
- [ ] Optional account-backed sync
- [ ] Stronger offline last-known AQI

### Out of scope (for now)

- Multiplayer / social
- Regulatory AirNow equivalence claims
- Native App Store builds (PWA only)

## Accessibility / mobile

- Usable at ~390px.
- Swipe locks horizontal only so scroll still works.
- Forecast controls use `data-no-swipe`.
- Safe-area friendly viewport (`viewport-fit=cover`) for notched iPhones.
