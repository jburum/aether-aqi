# Product

Last updated: 2026-08-05 · **v1.3.0**

## One-liner

Personal **air quality watchlist** PWA: up to **15** places, live US AQI, hour/day forecasts, device-local save. Installable to the **iPhone Home Screen**.

## Core UX

| Action | Behavior |
| --- | --- |
| Open app | Watchlist cards (seeded defaults until edited) |
| Tap card | Expands in place: advice, pollutants, forecast. Tap again to collapse. |
| **By hour** | Area chart of hourly US AQI |
| **By day** | Bar chart of daily average US AQI; tap day → hourly for that day |
| Swipe left | Reveals **Delete** |
| **Hold + drag** card | Floating ghost follows finger; list live-swaps; order persisted |
| Add place | Full-width mobile sheet; search or current location; **max 15** |
| Refresh | Refetch all AQI queries |
| **Install (iPhone)** | Safari → Share → **Add to Home Screen** → standalone with app icon |

### Branding & icon

- UI titles: **Air Quality** / **Watchlist**
- App icon: dark tile with large **AQI number** and a green **line-chart** curve (`public/icon-*.png`, `apple-touch-icon.png`)
- Home screen short name: **Air Quality**

## Data expectations

- On-device only (see [ARCHITECTURE.md](./ARCHITECTURE.md)).
- Daily values = average of Open-Meteo hourly US AQI per calendar day.
- Adding a place does **not** auto-expand the new card (keeps the header on-screen).

## Roadmap

### Phase 1 (shipped)

- [x] Multi-location watchlist (**max 15**)
- [x] Live US AQI + pollutants
- [x] Hourly + day bar + day→hourly drill-down
- [x] PWA + iOS Home Screen install (meta, manifest, apple-touch-icon)
- [x] Custom AQI chart app icon
- [x] Device-local persistence
- [x] Swipe delete, expand cards
- [x] Long-press drag reorder with drag ghost + scroll lock
- [x] Mobile add sheet without horizontal bleed / focus-zoom pan
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

- Usable at ~390px; `overflow-x: hidden` on shell to prevent sideways bleed.
- Swipe locks horizontal only so scroll still works.
- Forecast controls use `data-no-swipe`.
- Inputs are **16px** so iOS does not zoom/pan on focus.
- Safe-area padding (`viewport-fit=cover`) for notched iPhones.
- Add sheet is full-width bottom sheet on phones; locks background scroll while open.
