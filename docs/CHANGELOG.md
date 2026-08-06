# Changelog

Newest first.

## 2026-08-05 — v1.4.0 (desktop + iOS polish, API proxy)

### Product

- Desktop: **grip-drag reorder**; **trash** on each card; swipe-delete latches open (no post-drag close bug).
- Sign-in chrome **removed** from the home shell (auth code kept for later).
- Chart times use **12-hour** labels (`2 PM`, `Fri 7:00 PM`).
- iPhone: safe-area top inset without a huge empty band under the Dynamic Island.
- AQI / geocode via **same-origin** `/api/aqi` and `/api/geocode` (Safari-friendly).

### Ops

- GitHub ↔ Vercel Git link; push `main` auto-deploys.
- Service worker reduced to cache **cleanup** (avoids stale HTML/CSS shells).
- Local workspace: `~/Projects/AQI`.

### Docs

- ARCHITECTURE / PRODUCT / README refreshed for v1.4.0.
- Phase 2 **map view** direction documented (IQAir-inspired UX, MapLibre + watchlist markers first).

## 2026-08-05 — Deploy path: native Git → Vercel

### Ops

- Linked Vercel project `aether-aqi` to GitHub `jburum/aether-aqi` (production branch `main`).
- Retired release-tarball `installCommand` bootstrap; builds from the git tree.
- Production redeploy of **v1.3.0** from local clone (`~/Projects/AQI`).
- Docs updated for auto-deploy on push to `main`.

## 2026-08-05 — v1.3.0 (docs + ship)

### Product

- Watchlist capacity **5 → 15**.
- Long-press reorder with **floating drag ghost**, live list swap, scroll lock (no body `position: fixed`).
- Add-location **full-width** mobile sheet; no horizontal bleed when keyboard opens.
- Inputs at **16px** to stop iOS focus-zoom pan.
- Adding a place no longer auto-expands (header stays on-screen).

### Docs / ops

- Docs refreshed for v1.3.0 (PRODUCT, ARCHITECTURE, README).
- GitHub release **v1.3.0** + Vercel production redeploy.

## 2026-08-05 — 15 locations + add-sheet overflow fix

### Product

- Watchlist capacity raised from **5 → 15** places.
- Add-location sheet is full-width on phones, clamps to the viewport, and no longer lets the page slide sideways (iOS keyboard/focus zoom + overflow).
- Inputs use 16px text to prevent Safari focus-zoom pan.

## 2026-08-05 — Long-press reorder location cards

### Product

- **Hold** a location card (~0.4s), then **drag** onto another card to reorder the watchlist.
- Order persists in `localStorage` with the rest of the list.
- Grip icon affordance on cards; subtitle hints “Hold to reorder · swipe left to delete”.
- Floating ghost + placeholder slot so motion is obvious.

## 2026-08-05 — iOS Home Screen PWA + AQI chart icon (v1.2.0)

### Product

- Proper **Add to Home Screen** support for iPhone (standalone meta, apple-touch-icons 180/167/152, manifest icons).
- New app icon: dark tile, bold AQI number **42**, green line-chart / AQI label.
- SW cache bumped to `aqi-watchlist-v3` (includes new icons).

## 2026-08-05 — Docs in git, push, production redeploy (v1.1.0)

### Docs / ops

- Full docs package under `docs/` committed to GitHub with app source.
- Release **v1.1.0** source tarball for Vercel install bootstrap.
- Production redeploy of UI: day bars, hourly drill-down, swipe delete, debrand.

## 2026-08-05 — Day bar chart + hourly drill-down

### Product

- **By day**: bar chart of daily average US AQI (labels on bars, band colors).
- Tap a day (bar or chip) → hourly area chart for that day; **All days** returns.

## 2026-08-05 — Expand cards, swipe delete, debrand

### Product

- Removed “Aether” from UI, title, PWA short name, SW cache id.
- Swipe left → **Delete**.
- Tap card → expand with pollutants + forecast (hour / day).

### Docs

- Added `docs/README.md`, `ARCHITECTURE.md`, `PRODUCT.md`, `CHANGELOG.md`.

### Notes

- `alertAt` remains for Phase 2; not on swipe yet.
- localStorage key `aether-locations-v1` kept so lists are not wiped.

## 2026-08-05 — Initial AQI PWA + first Vercel production

- Multi-location US AQI PWA (Open-Meteo).
- GitHub `jburum/aether-aqi` + Vercel `aether-aqi` → https://aether-aqi.vercel.app
