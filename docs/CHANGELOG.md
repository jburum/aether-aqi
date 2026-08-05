# Changelog

Newest first.

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
- Detail panel folded into expanded card.

### Docs

- Added `docs/README.md`, `ARCHITECTURE.md`, `PRODUCT.md`, `CHANGELOG.md`.

### Notes

- `alertAt` remains for Phase 2; not on swipe yet.
- localStorage key `aether-locations-v1` kept so lists are not wiped.

## 2026-08-05 — Initial AQI PWA + first Vercel production

- Multi-location US AQI PWA (Open-Meteo).
- Zustand + localStorage; max 5; default places.
- GitHub `jburum/aether-aqi` + Vercel `aether-aqi` → https://aether-aqi.vercel.app
