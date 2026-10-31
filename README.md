# Air Quality Watchlist

PWA for tracking **US AQI** across up to **15** locations. Live readings and forecasts from [Open-Meteo](https://open-meteo.com/) (via same-origin API proxies); your list is stored **on each device**.

| | |
| --- | --- |
| **Live app** | [https://aether-aqi.vercel.app](https://aether-aqi.vercel.app) |
| **Repo** | [github.com/jburum/aether-aqi](https://github.com/jburum/aether-aqi) |
| **Local** | `~/Projects/AQI` |
| **Master** | `aether-aqi` — **active · closed** (stable, no backlog) |
| **Docs** | [docs/](./docs/) |
| **Latest** | **2026-10-30** — website map removed |
| **Status** | [docs/STATUS.md](./docs/STATUS.md) |

## Features

- Up to **15** saved places (search or current location)
- Live US AQI + PM2.5 / PM10 / O₃ / NO₂
- **By hour** area chart and **By day** bar chart (daily average, **12-hour** times)
- Tap a day to drill into that day’s hourly forecast
- **Trash** or swipe left to delete
- **Grip drag** (desktop) / hold-drag (phone) to reorder
- Installable PWA (Home Screen guide + branded share card)
- Data stays in the browser (`localStorage`)

## Documentation

| Doc | |
| --- | --- |
| [docs/STATUS.md](./docs/STATUS.md) | Active / closed posture |
| [docs/README.md](./docs/README.md) | Docs index |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Git → Vercel, field model, stack |
| [docs/PRODUCT.md](./docs/PRODUCT.md) | UX, roadmap |
| [docs/SHARE-INVITE.md](./docs/SHARE-INVITE.md) | Messages install copy |
| [docs/CHANGELOG.md](./docs/CHANGELOG.md) | What shipped |

## Develop

```bash
cd ~/Projects/AQI
npm install
npm run dev        # http://0.0.0.0:8080
npm run typecheck
npm run build
npm test           # PGLite only; no Postgres
npm run lint
```

## Tests

`npm test` runs `src/lib/v1/week1.test.ts` on in-memory PGLite. A clean checkout does not need Postgres.

`npm run test:integration` runs the saved-place race in `src/lib/v1/week1.integration.test.ts`. It opens a real Postgres, applies `migrations/`, then creates and drops a scratch database. Connection is env-only (no values are committed):

| Env | When unset |
| --- | --- |
| `AQI_TEST_DATABASE_URL` | Use the fields below. If set, it wins. |
| `AQI_TEST_PGHOST` | `/tmp` (Unix socket) |
| `AQI_TEST_PGPORT` | `5432` |
| `AQI_TEST_PGUSER` | Current OS user |
| `AQI_TEST_PGPASSWORD` | No password |
| `AQI_TEST_PGDATABASE` | `postgres` (admin database, not the scratch db) |

The role needs `CREATEDB` and visibility of `pg_stat_activity`. Names and placeholders: [.env.example](./.env.example).

Pull requests run test, lint, and build on GitHub-hosted `ubuntu-latest` (no Postgres). A second job runs `npm run test:integration` against a Postgres service container.

## Deploy

**Push `main`** → Vercel project **aether-aqi** auto-deploys.

```bash
vercel deploy --prod   # optional manual production deploy
```

Details: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Data disclaimer

AQI is **modeled** (Open-Meteo / CAMS), not a regulatory feed. Cross-check [AirNow](https://www.airnow.gov/) during smoke events.
