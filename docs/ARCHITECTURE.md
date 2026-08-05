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
| **GitHub** | Source of truth (`jburum/aether-aqi`, public). Docs live under `docs/`. Release assets (`clean-aether.tgz`) bootstrap full installs when file-tree deploy payloads are too large. |
| **Vercel** | Production. Project `aether-aqi` → [https://aether-aqi.vercel.app](https://aether-aqi.vercel.app). |

### Current production deploy method

1. Verify app in Grok Build (`typecheck`, browser smoke).
2. Commit + push full source (including `docs/`) to `main`.
3. Publish a **GitHub Release** with `clean-aether.tgz` (app source, no `node_modules`).
4. Vercel **installCommand** curls that tarball, extracts, runs `npm install`; **buildCommand** is `npm run build`.

Ideal later: native Vercel ↔ GitHub integration so every push auto-deploys without a release bootstrap.

### What is *not* in the pipeline

- End-user devices never talk to Grok Build or GitHub for AQI.
- Browser → **Open-Meteo** (+ geocoding) for readings/forecasts.
- Browser **localStorage** for the watchlist.

---

## Data storage

### On each device

| Data | Where | Cross-device? |
| --- | --- | --- |
| Watchlist (name, lat/lon, `alertAt`) | `localStorage` via Zustand `persist` key `aether-locations-v1` | **No** |
| Expanded/selected card id | Same store | No |
| Live AQI cache | React Query (memory) | No |
| Optional SW cache | Cache API | No |
| “Already alerted this hour” | `sessionStorage` | No |

There is **no cloud watchlist sync**. Phone and desktop lists are independent.

Optional **Sign in** (better-auth) is shell-level only; it does not own the location list.

### Third-party APIs

| Data | Provider |
| --- | --- |
| Live + hourly US AQI, pollutants | [Open-Meteo Air Quality](https://open-meteo.com/en/docs/air-quality-api) (CAMS) |
| Place search | Open-Meteo Geocoding |
| Reverse geocode | BigDataCloud free client endpoint |

Modeled AQI is **not** a regulatory monitor (AirNow). Cross-check during wildfire smoke.

---

## Stack

- React 19, TanStack Start / Router / Query, Tailwind v4, Radix/shadcn, Recharts, Lucide
- Zustand + `persist` for locations
- PWA: `public/manifest.webmanifest` + `public/sw.js`
- Vite 8; Nitro Vercel preset on production build only
- Optional better-auth + PGlite/Postgres migrations (not required for core watchlist)

### Key source files

| Path | Responsibility |
| --- | --- |
| `src/components/aqi-components.tsx` | Cards, swipe delete, expand, hour/day charts, day drill-down |
| `src/lib/locations-store.ts` | Locations store + localStorage |
| `src/lib/open-meteo.ts` | AQ + geocoding clients |
| `src/lib/aqi.ts` | US AQI bands / labels / advice |
| `public/manifest.webmanifest` | Install metadata |
| `public/sw.js` | Light offline / API cache |
| `docs/` | Product + architecture docs (in git) |
| `startup.sh` | Revive Grok preview dev server |

---

## Runtime product behavior

1. Load locations from `localStorage` (seeded defaults on first visit).
2. Fetch AQI per location (React Query; refetch ~15 min).
3. **Tap card** → expand: pollutants + forecast.
4. **By hour** → full-window area chart. **By day** → bar chart of daily **average** AQI; tap day → hourly for that day.
5. **Swipe left** → Delete (Phase 1). Alert-threshold swipe is Phase 2.
6. Add place via search or geolocation (max 5).

---

## Deploy checklist

1. App works in Grok preview; console clean.
2. `npm run typecheck` + `npm run build` pass.
3. Docs updated (`CHANGELOG` + product/architecture as needed).
4. Push to GitHub `main` (docs included).
5. Release tarball updated if Vercel install still curls a release asset.
6. Vercel production READY; public URL shows current UI.
