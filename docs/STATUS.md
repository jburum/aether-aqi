# Status — aether-aqi (website and AirHappy for iOS)

| | |
| --- | --- |
| **Status** | Website **stable**. **AirHappy** for iOS in **internal TestFlight**; public App Store **on hold** |
| **Meaning** | The PWA is live and unchanged. New work is the native app and its v1 API. Nothing is submitted for App Review or published. |
| **As of** | 2026-11-06 |
| **Version** | Website: map removed, share/install remain. iOS: AirHappy 0.1 (3) |
| **Live** | https://aether-aqi.vercel.app |
| **Repo** | https://github.com/jburum/aether-aqi |
| **Local** | `~/Projects/AQI` |
| **Master id** | `aether-aqi` |

## AirHappy for iOS

Native SwiftUI app in `ios/`, bundle ID `dev.bbcvc.airhappy`, BBCVC LLC team. App Store Connect record **AirHappy by BBCVC**.

| Build | What is in it |
| --- | --- |
| 0.1 (1) | First signed upload. Sample air. |
| 0.1 (2) | Tamarack Resort sample place. Pro unlocked in the internal build. |
| 0.1 (3) | Live Open-Meteo air (testing only) at Tamarack. Best window, outlook and alerts are sample. Pro unlocked. |

Purchases are not live. The public App Store waits for Jason.

| Doc | |
| --- | --- |
| [appstore/ROADMAP.md](./appstore/ROADMAP.md) | Decisions, builds, v1 scope, future intent (widget, map and the rest) |
| [appstore/BACKLOG.md](./appstore/BACKLOG.md) | What is left before a public build |
| [appstore/IOS-PLAN.md](./appstore/IOS-PLAN.md) | Architecture, capabilities, TestFlight upload steps |
| [appstore/AIRHAPPY-LISTING.md](./appstore/AIRHAPPY-LISTING.md) | Listing and privacy label draft |
| [../ios/README.md](../ios/README.md) | Building and running the app |

## Website

- Product is **usable daily** (list + install + share). The website map is removed.
- No scheduled website work. Fix production bugs if they appear. Push to `main` still auto-deploys.
- `/support` and `/privacy` pages for AirHappy are in the web app (#42).

## Shipped surface area (website)

| Area | Status |
| --- | --- |
| Watchlist (≤15 places), cards, forecasts | Stable |
| Desktop grip reorder + trash; mobile swipe delete | Stable |
| 12h chart times; iPhone safe-area shell | Stable |
| Website map (`/map`, MapLibre, `/api/aqi-grid`) | **Removed** 2026-10-30. iOS map is v1.1 |
| OG share card (`/og-image.png`) | Stable |
| In-app Home Screen install guide + invite copy | Stable |
| Git → Vercel auto-deploy | Stable |

## Not planned

- Capacitor or a WebView App Store build ([IOS-APP-STORE.md](./IOS-APP-STORE.md) is superseded)
- Cloud sync and denser commercial heatmaps on the website
- Perfect IQAir-class modeling on the website (it uses Open-Meteo CAMS samples + IDW)

## Operator notes

- **Install (website):** Safari → Share → Add to Home Screen · [SHARE-INVITE.md](./SHARE-INVITE.md)
- **Data (website):** Modeled AQI, not AirNow regulatory
- **Data (AirHappy launch):** NOAA smoke model and AirNow from the v1 API. See [appstore/ROADMAP.md](./appstore/ROADMAP.md).
- **Map:** Not on the website. iOS map is v1.1.

## Session close (2026-08-06)

Documented full stack, registered in Master as active/stable, changelog + product/arch updated. **Session ended with no open engineering backlog.**
