# Architecture

Last updated: 2026-08-05 · **v1.3.0**

## Pipeline: Local / Grok Build → Git → Vercel

```text
┌─────────────────────┐     git push main          ┌──────────────┐     auto install/build ┌─────────────┐
│  Local (Projects/AQI)│ ─────────────────────────► │    GitHub    │ ─────────────────────► │   Vercel    │
│  or Grok Build preview│    jburum/aether-aqi      │  production  │   Git-linked project   │ aether-aqi  │
│                     │                            │  branch main │                        │             │
└─────────────────────┘                            └──────────────┘                        └─────────────┘
```

| Stage | Role |
| --- | --- |
| **Local / Grok Build** | Develop and verify (preview). Local clone: `~/Projects/AQI`. |
| **GitHub** | Source of truth (`jburum/aether-aqi`). Docs under `docs/`. Tags/releases optional for history. |
| **Vercel** | Production → [https://aether-aqi.vercel.app](https://aether-aqi.vercel.app). Project `aether-aqi` is **Git-linked** to this repo. |

**Current deploy path (as of 2026-08-05):** Native Vercel ↔ GitHub integration. Production branch is **`main`**. On push to `main`, Vercel runs default `npm install` + `npm run build` (Nitro `vercel` preset). No custom `installCommand`.

**CLI alternatives:**

```bash
cd ~/Projects/AQI
vercel link --project aether-aqi --scope jburums-projects --yes   # once
vercel deploy --prod --yes                                        # manual prod deploy
```

**Historical note:** Early Grok Build publishes used a release-tarball bootstrap (`installCommand` curled `clean-aether.tgz` from GitHub Releases). That path is **retired**; keep release tags for changelog only if useful.

---

## Data storage

### On each device

| Data | Where | Cross-device? |
| --- | --- | --- |
| Watchlist (name, lat/lon, `alertAt`, **order**) | `localStorage` key `aether-locations-v1` | **No** |
| Selected card id | Same store | No |
| Live AQI cache | React Query | No |
| SW cache | Cache API (`aqi-watchlist-v3`) | No |

- Max **15** locations (`MAX_LOCATIONS` in `src/lib/locations-store.ts`).
- Array order in the store **is** display order (drag-to-reorder updates it).
- No cloud watchlist sync.

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

## Interaction notes (mobile)

| Concern | Approach |
| --- | --- |
| Reorder | Long-press → floating ghost under finger; non-passive `touchmove` + overflow lock; live list swap |
| Swipe delete | Axis-locked horizontal pan; vertical scroll still works |
| Add sheet | Full-width bottom sheet; body `overflow: hidden` while open; no `position: fixed` body (avoids iOS header clip) |
| Focus zoom | Inputs `font-size: 16px`; shell `overflow-x: hidden` |

---

## Stack

- React 19, TanStack Start/Router/Query, Tailwind v4, Recharts, Lucide, Zustand
- Vite 8; Nitro Vercel preset on production build only

### Key files

| Path | Responsibility |
| --- | --- |
| `src/components/aqi-components.tsx` | Cards, swipe, reorder ghost, expand, charts, add sheet |
| `src/lib/locations-store.ts` | localStorage watchlist + reorder (max 15) |
| `src/lib/open-meteo.ts` | AQ + geocoding |
| `public/*icon*` | Home screen / PWA icons |
| `docs/` | Product + architecture (in git) |

---

## Deploy checklist

1. Preview + `typecheck` / `build` OK.
2. Docs updated (`CHANGELOG`, `PRODUCT`, `ARCHITECTURE` as needed).
3. Commit and **push `main`** → Vercel auto-deploys production.
4. Optional: `vercel deploy --prod` from `~/Projects/AQI` for a CLI ship without waiting on Git.
5. Optional: GitHub release/tag for version history (not required for deploy).
6. Confirm production: Watchlist UI (15 locations), icons, add sheet full-width, reorder.
