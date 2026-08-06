# Status — Air Quality Watchlist (aether-aqi)

| | |
| --- | --- |
| **Status** | **Active · closed for development** |
| **Meaning** | Live production PWA; code is **stable**; **no open backlog** for this cycle |
| **As of** | 2026-08-06 |
| **Version** | v1.6.x (map lattice field + share/install) |
| **Live** | https://aether-aqi.vercel.app |
| **Repo** | https://github.com/jburum/aether-aqi |
| **Local** | `~/Projects/AQI` |
| **Master id** | `aether-aqi` |

## What “closed for now” means

- Product is **usable daily** (list + map + install + share).
- **No scheduled work** or ticket backlog.
- Reopen only for **intentional** new work (e.g. alerts, Capacitor App Store, denser map tiles).
- Ops: push to `main` still auto-deploys; fix production bugs if they appear.

## Shipped surface area

| Area | Status |
| --- | --- |
| Watchlist (≤15 places), cards, forecasts | Stable |
| Desktop grip reorder + trash; mobile swipe delete | Stable |
| 12h chart times; iPhone safe-area shell | Stable |
| MapLibre map + pin numbers + locate | Stable |
| Regional AQI wash (fixed 2° lattice, pure `aqiAt`) | Stable enough for now |
| Map pan without freeze (deferred paint) | Stable |
| OG share card (`/og-image.png`) | Stable |
| In-app Home Screen install guide + invite copy | Stable |
| Git → Vercel auto-deploy | Stable |

## Intentionally not in backlog

- Capacitor / App Store (plan only: [IOS-APP-STORE.md](./IOS-APP-STORE.md))
- AQI alerts, cloud sync, denser commercial heatmaps
- Perfect IQAir-class modeling (we use Open-Meteo CAMS samples + IDW)

## Operator notes

- **Install:** Safari → Share → Add to Home Screen · [SHARE-INVITE.md](./SHARE-INVITE.md)
- **Data:** Modeled AQI, not AirNow regulatory
- **Map field:** Zoom-stable lattice; desktop/mobile share same sample cells when seed is watchlist-based

## Session close (2026-08-06)

Documented full stack, registered in Master as active/stable, changelog + product/arch updated. **Session ended with no open engineering backlog.**
