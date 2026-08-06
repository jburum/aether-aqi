# Air Quality Watchlist — Documentation

Installable PWA for **US AQI** tracking and forecasts across up to **15 locations**.

| | |
| --- | --- |
| **Production** | [https://aether-aqi.vercel.app](https://aether-aqi.vercel.app) |
| **GitHub** | [jburum/aether-aqi](https://github.com/jburum/aether-aqi) |
| **Local path** | `~/Projects/AQI` |
| **Latest** | **v1.4.0** |
| **Vercel project** | `aether-aqi` (`prj_xr5xTg1NcyiSgnmmnwULDr3uaEA9`) |
| **Team** | `jburums-projects` (`team_gaGBOmCnGAgxtsgBPV47cTrm`) |

## Docs map

| Doc | Purpose |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Deploy pipeline, storage, API proxies, stack, iOS inset notes |
| [PRODUCT.md](./PRODUCT.md) | UX, roadmap, **map view** direction |
| [CHANGELOG.md](./CHANGELOG.md) | Ship history (newest first) |
| [../README.md](../README.md) | Repo root overview |

## Current product snapshot (v1.4.0)

- Up to **15** saved locations, order on-device
- Expand cards → hour / day forecast (12h labels)
- Trash · swipe delete · grip / hold-drag reorder
- Same-origin AQI proxy (reliable on Safari)
- iOS safe-area top; Home Screen install + custom icon

## Keeping docs current

1. **CHANGELOG.md** — what / why (top entry).
2. **PRODUCT.md** — UX or roadmap changes.
3. **ARCHITECTURE.md** — storage, APIs, deploy, mobile chrome.
4. This index — URLs and version.

Convention: docs = product intent; code = behavior. Ship docs **with** the app when possible.
