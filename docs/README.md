# Air Quality Watchlist — Documentation

Installable PWA for **US AQI** tracking and forecasts across up to **5 locations**.

| | |
| --- | --- |
| **Production** | [https://aether-aqi.vercel.app](https://aether-aqi.vercel.app) |
| **GitHub** | [jburum/aether-aqi](https://github.com/jburum/aether-aqi) |
| **Vercel project** | `aether-aqi` (`prj_xr5xTg1NcyiSgnmmnwULDr3uaEA9`) |
| **Team** | `team_gaGBOmCnGAgxtsgBPV47cTrm` (jburums-projects) |

## Docs map

| Doc | Purpose |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Pipeline (Grok Build → GitHub → Vercel), data storage, stack, deploy |
| [PRODUCT.md](./PRODUCT.md) | Features, UX flows, roadmap / phases |
| [CHANGELOG.md](./CHANGELOG.md) | Ship history (newest first) |
| [../README.md](../README.md) | Repo root overview for GitHub visitors |

## Keeping docs current

When shipping a meaningful change:

1. **CHANGELOG.md** — what / why (top entry).
2. **PRODUCT.md** — if UX or roadmap changes.
3. **ARCHITECTURE.md** — if storage, APIs, or deploy path changes.
4. This index — keep URLs and project IDs accurate.

Convention: docs = product intent; code = behavior. Docs ship **in the same git commit** as the app when possible.
