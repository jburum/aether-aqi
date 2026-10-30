# Air Quality Watchlist — Documentation

Installable PWA for **US AQI** tracking and forecasts across up to **15 locations**.

| | |
| --- | --- |
| **Production** | [https://aether-aqi.vercel.app](https://aether-aqi.vercel.app) |
| **GitHub** | [jburum/aether-aqi](https://github.com/jburum/aether-aqi) |
| **Local path** | `~/Projects/AQI` |
| **Master id** | `aether-aqi` |
| **Status** | **Active · closed for development** (stable, no backlog) — [STATUS.md](./STATUS.md) |
| **Latest** | **2026-10-30** (website map removed; iOS map is v1.1) |
| **Vercel project** | `aether-aqi` |
| **Team** | `jburums-projects` |

## Docs map

| Doc | Purpose |
| --- | --- |
| **[STATUS.md](./STATUS.md)** | **Posture: active/stable/closed** |
| [SESSION-CLOSE-2026-08-06.md](./SESSION-CLOSE-2026-08-06.md) | Session handoff |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Deploy, storage, stack |
| [PRODUCT.md](./PRODUCT.md) | UX + roadmap snapshot |
| [SHARE-INVITE.md](./SHARE-INVITE.md) | iMessage install copy |
| [IOS-APP-STORE.md](./IOS-APP-STORE.md) | Future Capacitor App Store plan (not in backlog) |
| [CHANGELOG.md](./CHANGELOG.md) | Ship history (newest first) |
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
