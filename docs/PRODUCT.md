# Product

Last updated: 2026-08-05 · **v1.4.0**

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

### Phase 2 (planned)

- [ ] **Map view** of watchlist (and later regional AQI) — see below
- [ ] AQI threshold alerts (`alertAt` already stored per place)
- [ ] Optional account-backed sync
- [ ] Stronger offline last-known AQI

### Out of scope (for now)

- Multiplayer / social
- Regulatory AirNow equivalence claims
- Native App Store builds (PWA only)
- Cloning IQAir’s proprietary 3D globe / station network wholesale

---

## Map view direction (Phase 2)

**Reference product:** [IQAir AirVisual](https://www.iqair.com/air-quality-monitors/air-quality-app) / [live map](https://www.iqair.com/air-quality-map) — full-screen map, AQI-colored points, layers (stations / fires / wind), tap → detail.

**What to copy (UX patterns):**

| Pattern | Why it works |
| --- | --- |
| Full-bleed map as a primary tab | Spatial mental model for “where is bad air?” |
| Color = US AQI band (EPA palette we already use) | Instant read without opening cards |
| Tap marker → sheet with current AQI + link to full card | Same data model as watchlist |
| Legend (Good → Hazardous) | Matches our `getAqiMeta` tokens |
| Optional layers later | Wind / smoke — not day one |

**What not to copy on day one:**

- Global 80k-station network (IQAir proprietary)
- 3D “AirVisual Earth” globe
- Indoor purifier control
- Paid heatmap tile vendors until we need them

**Recommended build path for *this* app:**

1. **v1 map — watchlist only**  
   MapLibre GL JS (or Leaflet) + MapTiler / OpenFreeMap / Protomaps basemap.  
   One circle marker per saved location, fill = AQI band color, label = AQI number.  
   Tap → bottom sheet (reuse expand-card content).  
   Fit bounds to watchlist; “Locate me” control.

2. **v1.5 — nearby sample grid**  
   Query Open-Meteo for a small lat/lon grid around the viewport center (throttled), show low-opacity dots or a simple filled contour. Still modeled CAMS data — honest disclaimer.

3. **v2 — true heatmap (optional)**  
   Google Air Quality API heatmap tiles, or self-served raster from a backend job. Higher cost/complexity; only if users need “paint the valley” views.

**Stack fit:** React 19 + TanStack Router tab (`/map`), keep Zustand locations + React Query AQI keys. Prefer **MapLibre** over Google Maps for cost and open basemaps; use Google only if we buy heatmap tiles.

**Honesty:** IQAir’s polish comes from exclusive station feeds + years of map UX. We can match the *interaction model* while staying on Open-Meteo and our 15-place watchlist — and label modeled vs monitor data clearly.

---

## Accessibility / mobile

- Usable at ~390px; `overflow-x: hidden` on shell.
- Swipe locks horizontal only so vertical scroll works.
- Forecast controls use `data-no-swipe`.
- Inputs **16px** (no iOS focus-zoom).
- Top padding: `env(safe-area-inset-top) + 10px` only (no large forced floor).
- Add sheet: full-width bottom sheet; locks background scroll while open.
