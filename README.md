# Air Quality Watchlist

PWA for tracking **US AQI** across up to five locations. Live readings and forecasts from [Open-Meteo](https://open-meteo.com/); your list is stored **on each device**.

| | |
| --- | --- |
| **Live app** | [https://aether-aqi.vercel.app](https://aether-aqi.vercel.app) |
| **Repo** | [github.com/jburum/aether-aqi](https://github.com/jburum/aether-aqi) |

## Features

- Up to **5** saved places (search or current location)
- Live US AQI + PM2.5 / PM10 / O₃ / NO₂
- **By hour** area chart and **By day** bar chart (daily average)
- Tap a day to drill into that day’s hourly forecast
- Swipe a card left to **delete**
- Installable PWA; data stays in the browser (`localStorage`)

## Documentation

| Doc | |
| --- | --- |
| [docs/README.md](./docs/README.md) | Docs index |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Grok Build → GitHub → Vercel, storage, stack |
| [docs/PRODUCT.md](./docs/PRODUCT.md) | UX and roadmap |
| [docs/CHANGELOG.md](./docs/CHANGELOG.md) | What shipped |

## Develop

```bash
npm install
npm run dev        # http://0.0.0.0:8080
npm run typecheck
npm run build
```

## Deploy path

Source of truth is this repo. Production is Vercel project **aether-aqi**.  
When using the release-bootstrap install (large trees), attach a clean source tarball to a GitHub Release and point Vercel `installCommand` at that asset. Details: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Data disclaimer

AQI is **modeled** (Open-Meteo / CAMS), not a regulatory feed. Cross-check [AirNow](https://www.airnow.gov/) during smoke events.
