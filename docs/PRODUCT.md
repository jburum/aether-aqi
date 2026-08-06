# Product

Last updated: 2026-08-05 · **v1.5.0**

## One-liner

Personal **air quality watchlist** PWA: up to **15** places, live US AQI, hour/day forecasts, device-local save. Installable to the **iPhone Home Screen**.

## Core UX

| Action | Behavior |
| --- | --- |
| Open app | Watchlist cards (seeded defaults until edited) |
| Tap card | Expands in place: advice, pollutants, forecast. Tap again to collapse. |
| **By hour** | Area chart of hourly US AQI (**12-hour** clock labels) |
| **By day** | Bar chart of daily average US AQI; tap day → hourly for that day |
| Trash icon | Removes location (desktop-friendly) |
| Swipe left | Reveals **Delete** (latches open until Delete or tap-away) |
| **Grip drag** | Reorder (desktop). Touch: hold then drag with floating ghost |
| Add place | Full-width mobile sheet; search or current location; **max 15** |
| Refresh | Refetch all AQI queries (same-origin `/api/aqi`) |
| **Install (iPhone)** | Safari → Share → **Add to Home Screen** |

### Branding & icon

- UI titles: **Air Quality** / **Watchlist**
- App icon: dark tile, bold AQI number + green chart curve
- Home screen short name: **Air Quality**
- Sign-in chrome: **hidden** (optional accounts remain a Phase 2 idea)

## Data expectations

- On-device only (see [ARCHITECTURE.md](./ARCHITECTURE.md)).
- Daily values = average of Open-Meteo hourly US AQI per calendar day.
- Adding a place does **not** auto-expand the new card.
- AQI is **modeled** (CAMS / Open-Meteo), not AirNow regulatory.

## Roadmap

### Phase 1 (shipped)

- [x] Multi-location watchlist (**max 15**)
- [x] Live US AQI + pollutants (via `/api/aqi` proxy)
- [x] Hourly + day bar + day→hourly drill-down
- [x] PWA + iOS Home Screen install
- [x] Custom AQI chart app icon
- [x] Device-local persistence
- [x] Expand cards, swipe delete, **trash control**
- [x] Grip / long-press reorder with drag ghost
- [x] Mobile add sheet (no sideways bleed / focus-zoom)
- [x] Desktop reorder + delete fixed
- [x] 12-hour chart times
- [x] iPhone safe-area top inset (no huge empty band)
- [x] Git → Vercel auto-deploy from `~/Projects/AQI`
- [x] Docs in git

### Phase 1.5 (shipped)

- [x] **Map tab** — MapLibre, AQI pins for watchlist, tap sheet, locate me, list↔map nav

### Phase 2 (planned)

- [ ] Map: nearby Open-Meteo sample grid / soft heatmap
- [ ] AQI threshold alerts (`alertAt` already stored per place)
- [ ] Optional account-backed sync
- [ ] Stronger offline last-known AQI
- [ ] **iOS App Store** free app via Capacitor — see [IOS-APP-STORE.md](./IOS-APP-STORE.md)

### Out of scope (for now)

- Multiplayer / social
- Regulatory AirNow equivalence claims
- Native App Store builds (PWA only)
- Cloning IQAir’s proprietary 3D globe / station network wholesale

---

## Map view

**Shipped (Phase A):** `/map` tab — MapLibre + Carto Dark Matter basemap, AQI-colored pins for watchlist places, tap → detail sheet, Locate me, fit bounds, List ↔ Map bottom nav.

**Reference UX:** [IQAir AirVisual](https://www.iqair.com/air-quality-monitors/air-quality-app) (patterns only — not their station network or 3D globe).

**Next map steps:**

1. Nearby Open-Meteo grid sample (soft regional context)
2. Optional true heatmap tiles (Google AQ API) if users need it

---

## Accessibility / mobile

- Usable at ~390px; `overflow-x: hidden` on shell.
- Swipe locks horizontal only so vertical scroll works.
- Forecast controls use `data-no-swipe`.
- Inputs **16px** (no iOS focus-zoom).
- Top padding: `env(safe-area-inset-top) + 10px` only (no large forced floor).
- Add sheet: full-width bottom sheet; locks background scroll while open.
