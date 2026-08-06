# Air Quality Watchlist

PWA for tracking **US AQI** across up to **15** locations. Live readings and forecasts from [Open-Meteo](https://open-meteo.com/) (via same-origin API proxies); your list is stored **on each device**.

| | |
| --- | --- |
| **Live app** | [https://aether-aqi.vercel.app](https://aether-aqi.vercel.app) |
| **Repo** | [github.com/jburum/aether-aqi](https://github.com/jburum/aether-aqi) |
| **Local** | `~/Projects/AQI` |
| **Docs** | [docs/](./docs/) |
| **Latest** | **v1.4.0** |

## Features

- Up to **15** saved places (search or current location)
- Live US AQI + PM2.5 / PM10 / O₃ / NO₂
- **By hour** area chart and **By day** bar chart (daily average, **12-hour** times)
- Tap a day to drill into that day’s hourly forecast
- **Trash** or swipe left to delete
- **Grip drag** (desktop) / hold-drag (phone) to reorder
- Installable PWA (iPhone Home Screen + custom icon)
- Data stays in the browser (`localStorage`)

## Documentation

| Doc | |
| --- | --- |
| [docs/README.md](./docs/README.md) | Docs index |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Git → Vercel, proxies, stack |
| [docs/PRODUCT.md](./docs/PRODUCT.md) | UX, roadmap, map plan |
| [docs/CHANGELOG.md](./docs/CHANGELOG.md) | What shipped |

## Develop

```bash
cd ~/Projects/AQI
npm install
npm run dev        # http://0.0.0.0:8080
npm run typecheck
npm run build
```

## Deploy

**Push `main`** → Vercel project **aether-aqi** auto-deploys.

```bash
vercel deploy --prod   # optional manual production deploy
```

Details: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Data disclaimer

AQI is **modeled** (Open-Meteo / CAMS), not a regulatory feed. Cross-check [AirNow](https://www.airnow.gov/) during smoke events.
