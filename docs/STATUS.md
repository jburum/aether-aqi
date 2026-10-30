# Status — Air Quality Watchlist (aether-aqi)

| | |
| --- | --- |
| **Status** | **Active · closed for development** |
| **Meaning** | Live production PWA; code is **stable**; **no open backlog** for this cycle |
| **As of** | 2026-10-30 |
| **Version** | Website map removed; share/install remain |
| **Live** | https://aether-aqi.vercel.app |
| **Repo** | https://github.com/jburum/aether-aqi |
| **Local** | `~/Projects/AQI` |
| **Master id** | `aether-aqi` |

## What “closed for now” means

- Product is **usable daily** (list + install + share). The website map is removed.
- **No scheduled work** or ticket backlog.
- Reopen only for **intentional** new work (e.g. alerts, iOS v1, map as iOS v1.1).
- Ops: push to `main` still auto-deploys; fix production bugs if they appear.

## Shipped surface area

| Area | Status |
| --- | --- |
| Watchlist (≤15 places), cards, forecasts | Stable |
| Desktop grip reorder + trash; mobile swipe delete | Stable |
| 12h chart times; iPhone safe-area shell | Stable |
| Website map (`/map`, MapLibre, `/api/aqi-grid`) | **Removed** 2026-10-30. iOS map is v1.1 |
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
- **Map:** Not on the website. iOS map is v1.1.

## Session close (2026-08-06)

Documented full stack, registered in Master as active/stable, changelog + product/arch updated. **Session ended with no open engineering backlog.**
