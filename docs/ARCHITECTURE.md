# Architecture

Last updated: 2026-08-05

## Pipeline: Grok Build → Git → Vercel

```text
┌─────────────────────┐     git push + release     ┌──────────────┐     install/build     ┌─────────────┐
│  Grok Build sandbox │ ─────────────────────────► │    GitHub    │ ────────────────────► │   Vercel    │
│  edit + live preview│     jburum/aether-aqi      │  main +      │   production host     │ aether-aqi  │
│                     │                            │  release tgz │                       │             │
└─────────────────────┘                            └──────────────┘                       └─────────────┘
```

| Stage | Role |
| --- | --- |
| **Grok Build** | Develop and verify (live preview). Not production. |
| **GitHub** | Source of truth (`jburum/aether-aqi`). Docs under `docs/`. Release `clean-aether.tgz` for Vercel bootstrap when needed. |
| **Vercel** | Production → [https://aether-aqi.vercel.app](https://aether-aqi.vercel.app). |

Ideal later: native Vercel ↔ GitHub auto-deploy on push.

---

## Data storage

### On each device

| Data | Where | Cross-device? |
| --- | --- | --- |
| Watchlist (name, lat/lon, `alertAt`) | `localStorage` key `aether-locations-v1` | **No** |
| Selected card id | Same store | No |
| Live AQI cache | React Query | No |
| SW cache | Cache API (`aqi-watchlist-v3`) | No |

No cloud watchlist sync. Optional Sign in does not own the location list.

### Third-party APIs

| Data | Provider |
| --- | --- |
| US AQI + pollutants | Open-Meteo Air Quality (CAMS) |
| Place search | Open-Meteo Geocoding |
| Reverse geocode | BigDataCloud |

Modeled AQI ≠ AirNow regulatory monitors.

---

## PWA / iOS Home Screen

| Piece | Path / value |
| --- | --- |
| Web app manifest | `public/manifest.webmanifest` (`display: standalone`, icons, theme `#0c0f12`) |
| Service worker | `public/sw.js` |
| Android / general icons | `icon-192.png`, `icon-512.png` |
| iOS home icons | `apple-touch-icon.png` (180), `-167`, `-152` |
| Meta | `apple-mobile-web-app-capable`, `apple-mobile-web-app-title`, `mobile-web-app-capable`, `theme-color` |

**User install (iPhone):** open production URL in **Safari** → Share → **Add to Home Screen**. Must use Safari (not in-app browsers) for reliable install.

---

## Stack

- React 19, TanStack Start/Router/Query, Tailwind v4, Recharts, Lucide, Zustand
- Vite 8; Nitro Vercel preset on production build only

### Key files

| Path | Responsibility |
| --- | --- |
| `src/components/aqi-components.tsx` | Cards, swipe, expand, charts |
| `src/lib/locations-store.ts` | localStorage watchlist |
| `src/lib/open-meteo.ts` | AQ + geocoding |
| `public/*icon*` | Home screen / PWA icons |
| `docs/` | Product + architecture (in git) |

---

## Deploy checklist

1. Preview + `typecheck` / `build` OK.
2. Docs updated.
3. Push `main` (+ release tarball if install still curls GitHub release).
4. Vercel production READY; icons load on production URL.
