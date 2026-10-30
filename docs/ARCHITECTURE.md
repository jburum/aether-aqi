# Architecture

Last updated: 2026-10-30 · status: [STATUS.md](./STATUS.md)

## Pipeline: Local → Git → Vercel

```text
┌──────────────────────┐   git push main   ┌──────────────┐   auto build   ┌─────────────┐
│  ~/Projects/AQI      │ ────────────────► │   GitHub     │ ─────────────► │   Vercel    │
│  (or Grok Build)     │   jburum/aether-aqi│  branch main │               │ aether-aqi  │
└──────────────────────┘                   └──────────────┘               └─────────────┘
```

| Stage | Role |
| --- | --- |
| **Local** | Source of day-to-day work: `~/Projects/AQI` |
| **GitHub** | Source of truth — [jburum/aether-aqi](https://github.com/jburum/aether-aqi) |
| **Vercel** | Production — [https://aether-aqi.vercel.app](https://aether-aqi.vercel.app) |

**Deploy:** Project is **Git-linked**. Push to `main` → `npm install` + `npm run build` (Vite + Nitro `vercel` preset). No custom `installCommand`.

```bash
cd ~/Projects/AQI
vercel link --project aether-aqi --scope jburums-projects --yes   # once
vercel deploy --prod --yes                                        # optional CLI ship
```

**Retired:** Grok Build release-tarball bootstrap (`clean-aether.tgz` curl install). Tags optional for history only.

---

## Data storage

### On each device

| Data | Where | Cross-device? |
| --- | --- | --- |
| Watchlist (name, lat/lon, `alertAt`, **order**) | `localStorage` key `aether-locations-v1` | **No** |
| Selected card id | Same store | No |
| Live AQI cache | React Query (client) | No |

- Max **15** locations (`MAX_LOCATIONS` in `src/lib/locations-store.ts`).
- Array order **is** display order (drag reorder updates it).
- No cloud watchlist sync. Auth UI is **hidden** (scaffolding remains for a future Phase 2).

### Third-party APIs (via same-origin proxies)

| Data | Upstream | App path |
| --- | --- | --- |
| US AQI + pollutants + hourly | Open-Meteo Air Quality (CAMS) | `GET /api/aqi?lat=&lon=` |
| Place search | Open-Meteo Geocoding | `GET /api/geocode?name=` |
| Reverse geocode | BigDataCloud (browser direct) | `src/lib/open-meteo.ts` |

**Why proxies:** Safari / ITP / blockers often stall third-party XHR to weather hosts. Client calls **same origin**; Vercel server fetches Open-Meteo with timeouts.

Modeled AQI ≠ AirNow regulatory monitors.

---

## PWA / iOS

| Piece | Path / value |
| --- | --- |
| Manifest | `public/manifest.webmanifest` (`standalone`, theme `#0c0f12`) |
| Service worker | `public/sw.js` — **cleanup-only** (clears old caches / unregisters; not used for offline HTML) |
| Icons | `icon-192/512`, `apple-touch-icon` 180/167/152 |
| OG share | `public/og-image.png` (1200×630); meta in `__root.tsx` |
| Viewport | `viewport-fit=cover` for notched phones |
| Top inset | `padding-top: calc(env(safe-area-inset-top) + 10px)` on `.aqi-shell` |

**Install (iPhone):** Safari → Share → **Add to Home Screen** (not in-app browsers). In-app guide: `src/components/install-guide.tsx`.

**Mobile layout notes:** Do **not** force a large min safe-area floor (e.g. 47–59px) on top of `env()` — that created a huge empty band under the Dynamic Island. Trust `env(safe-area-inset-top)` + a small breath.

---

## Interaction model

| Concern | Approach |
| --- | --- |
| **Desktop reorder** | Drag the **grip** (⋮⋮) — starts immediately |
| **Touch reorder** | Long-press card (~380ms), then drag; floating ghost |
| **Delete** | Trash icon on card, **or** swipe left → red Delete (latches open; post-drag click must not close rail) |
| **Add place** | Full-width bottom sheet; 16px inputs (no iOS focus-zoom) |
| **Charts** | Recharts; times in **12-hour** format (`h a`, `EEE h:mm a`) |

---

## Stack

- React 19, TanStack Start / Router / Query, Tailwind v4, Recharts, Lucide, Zustand
- Vite 8; Nitro `vercel` preset on production build only
- Auth (Better Auth + Grok broker) is **wired but not shown** in the UI

### Key files

| Path | Responsibility |
| --- | --- |
| `src/components/aqi-components.tsx` | Cards, gestures, charts, add sheet |
| `src/components/install-guide.tsx` | Home Screen install UX |
| `src/lib/locations-store.ts` | localStorage watchlist + reorder |
| `src/lib/open-meteo.ts` | Client fetch to `/api/aqi` and `/api/geocode` |
| `src/routes/api/aqi.ts` | Server proxy → Open-Meteo AQ |
| `src/routes/api/geocode.ts` | Server proxy → Open-Meteo search |
| `src/styles.css` + critical CSS in `__root.tsx` | Theme + safe-area shell |
| `docs/` | Product + architecture + status |

---

## Deploy checklist

1. `npm run typecheck` / `npm run build` OK.
2. Docs updated if UX / APIs / deploy changed.
3. **Push `main`** → Vercel production.
4. Smoke: watchlist loads AQI numbers, trash delete, grip reorder, iPhone top inset, 12h chart labels.

---

## Map

Removed from the website on 2026-10-30. There is no `/map` route, no MapLibre dependency, and no `/api/aqi-grid`. List AQI stays on React Query `["aqi", id, lat, lon]` via `GET /api/aqi`.

iOS map is **v1.1**, not in the first binary. The scope note is [appstore/ROADMAP.md](./appstore/ROADMAP.md), which is on #4 (`keel/appstore-docs-k1`) and updated on this branch. Older Capacitor notes: [IOS-APP-STORE.md](./IOS-APP-STORE.md).
