# Status — Air Quality Watchlist (aether-aqi)

| | |
| --- | --- |
| **Status** | **Reopened** for iOS v1 (PWA v1.6 remains the live site) |
| **Meaning** | Production PWA is unchanged. New work is the native client in [appstore/ROADMAP.md](./appstore/ROADMAP.md). Do not deploy from a planning branch. |
| **As of** | 2026-10-29 (Jason approved phase 1). Last product close: 2026-08-06 |
| **Version** | v1.6.x (map lattice field + share/install) |
| **Live** | https://aqi.burum.dev (same Vercel app as https://aether-aqi.vercel.app) |
| **Repo** | https://github.com/jburum/aether-aqi |
| **Local** | `~/Projects/AQI` |
| **Master id** | `aether-aqi` |

## Reopened (2026-10-29)

First Apple App Store app for **BBCVC**. Planning docs only. Company host in those docs is `bbcvc.dev`.

| Doc | |
| --- | --- |
| [appstore/ROADMAP.md](./appstore/ROADMAP.md) | v1 scope. Map is v1.1. Name, bundle ID, data stack, and pricing are open. About 32.5 Keel-days. |
| [appstore/AUDIT.md](./appstore/AUDIT.md) | Current product, stack, API licences, rough edges |
| [appstore/IOS-PLAN.md](./appstore/IOS-PLAN.md) | SwiftUI + WidgetKit + local alerts. Not a Capacitor WebView. |
| [appstore/LISTING.md](./appstore/LISTING.md) | Store copy and privacy draft |
| [appstore/BACKLOG.md](./appstore/BACKLOG.md) | Follow-up list. It does not pick the open decisions. |

The 2026-08-06 close still describes the live PWA. [IOS-APP-STORE.md](./IOS-APP-STORE.md) is superseded by native SwiftUI.

## What “closed for now” meant (2026-08-06)

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

## In this reopen, and outside it

In scope: SwiftUI on the existing `/api/aqi` and `/api/geocode`, location, threshold alerts, widget. See [appstore/ROADMAP.md](./appstore/ROADMAP.md).

Outside this reopen:

- Capacitor or a remote WebView ([IOS-APP-STORE.md](./IOS-APP-STORE.md) is superseded)
- iOS map (v1.1), and any removal of the website map
- Choosing the app name, bundle ID, data stack, or price
- Account sync, new launchd jobs, paid APIs, and an Xcode project in this repo
- Perfect IQAir-class modeling (the live site uses Open-Meteo CAMS samples + IDW)

## Operator notes

- **Install:** Safari → Share → Add to Home Screen · [SHARE-INVITE.md](./SHARE-INVITE.md)
- **Data:** Modeled AQI, not AirNow regulatory
- **Map field:** Zoom-stable lattice; desktop/mobile share same sample cells when seed is watchlist-based

## Session close (2026-08-06)

Documented full stack, registered in Master as active/stable, changelog + product/arch updated. **Session ended with no open engineering backlog.**
