# Air Quality Watchlist — Documentation

Installable PWA for **US AQI** tracking and forecasts across up to **15 locations**.

| | |
| --- | --- |
| **Production** | [https://aether-aqi.vercel.app](https://aether-aqi.vercel.app) |
| **GitHub** | [jburum/aether-aqi](https://github.com/jburum/aether-aqi) |
| **Local path** | `~/Projects/AQI` |
| **Master id** | `aether-aqi` |
| **Status** | Website stable. **AirHappy for iOS in internal TestFlight** (builds 1–3); public App Store on hold — [STATUS.md](./STATUS.md) |
| **Latest** | **2026-11-05** (AirHappy 0.1 (3), internal TestFlight) |
| **Vercel project** | `aether-aqi` |
| **Team** | `jburums-projects` |

## Docs map

| Doc | Purpose |
| --- | --- |
| **[STATUS.md](./STATUS.md)** | **Posture: website stable, iOS in internal TestFlight** |
| [SESSION-CLOSE-2026-08-06.md](./SESSION-CLOSE-2026-08-06.md) | Session handoff |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Deploy, storage, stack |
| [PRODUCT.md](./PRODUCT.md) | UX + roadmap snapshot |
| [SHARE-INVITE.md](./SHARE-INVITE.md) | iMessage install copy |
| [appstore/ROADMAP.md](./appstore/ROADMAP.md) | AirHappy: decisions, TestFlight builds, v1 scope, future intent |
| [appstore/BACKLOG.md](./appstore/BACKLOG.md) | Before the public App Store (P0), after v1 (P1), website items |
| [appstore/IOS-PLAN.md](./appstore/IOS-PLAN.md) | Native app plan, architecture, capabilities, TestFlight upload steps |
| [appstore/AIRHAPPY-LISTING.md](./appstore/AIRHAPPY-LISTING.md) | App Store listing and privacy label draft |
| [appstore/AUDIT.md](./appstore/AUDIT.md) | 2026-09-29 website audit (APIs, licences, gaps) |
| [IOS-APP-STORE.md](./IOS-APP-STORE.md) | Old Capacitor note — superseded |
| [CHANGELOG.md](./CHANGELOG.md) | Ship history (newest first) |
| [v1/WEEK1.md](./v1/WEEK1.md) | v1 week-1 forecast store, test push, and doc drift |
| [../README.md](../README.md) | Repo root overview |

## Product snapshot (stable)

- Up to **15** saved locations, order on-device
- Expand cards → hour / day forecast (**12h** labels)
- Trash · swipe delete · grip / hold-drag reorder
- Same-origin AQI / geocode proxies (Safari-friendly). No website map.
- iOS safe-area; **Home Screen** install guide; branded **OG share card**

## Keeping docs current

1. **CHANGELOG.md** — what / why (top entry).
2. **PRODUCT.md** / **STATUS.md** — UX or posture changes.
3. **ARCHITECTURE.md** — storage, APIs, deploy.
4. **Master** `Projects/registry.json` — `next_action` / summary.

Convention: docs = product intent; code = behavior. Ship docs **with** the app when possible.
