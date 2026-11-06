# Backlog — AirHappy before the public App Store

As of 2026-11-06. Scope and decisions are in [ROADMAP.md](./ROADMAP.md). The September audit of the website is [AUDIT.md](./AUDIT.md).

Internal TestFlight builds 1–3 are uploaded. The public App Store is on hold. Nothing on this list submits, releases, spends, or turns on live purchases. Those need Jason.

**S** is under a day. **M** is a few days. **ops** happens outside this repo (Apple, DNS, Vercel, a mailbox).

## Done

| Item | By |
| --- | --- |
| BBCVC LLC enrolled as an organization; Xcode signed in with the BBCVC team | 2026-11-05 |
| Bundle ID `dev.bbcvc.airhappy`, icon, export compliance, privacy manifest | 2026-11-05 |
| App Store Connect record “AirHappy by BBCVC”, SKU `airhappy-ios` | 2026-11-05 |
| Internal TestFlight builds 0.1 (1), (2) and (3), Phase 1 group | 2026-11-05 |
| Support and Privacy pages in the web app (`/support`, `/privacy`) | 2026-11-01 (#42) |
| Listing draft: [AIRHAPPY-LISTING.md](./AIRHAPPY-LISTING.md) | 2026-11-01 (#42) |

## P0 — before a public submission

| # | Task | Why | Effort |
| --- | --- | --- | --- |
| 1 | Connect the app to the v1 API (`/api/v1/*`): home, timeline, best window, outlook, alerts and saved places. | Launch data is NOAA and AirNow from our server. Build 3’s Open-Meteo feed is for testing only. | M |
| 2 | Decide how the app identifies itself to the v1 API (sign-in or another method). | The v1 routes need a user. The app has no sign-in today. | decision + M |
| 3 | Do not ship Open-Meteo’s free tier in a public build. | Its free tier is non-commercial. A subscription app is commercial (see [AUDIT.md](./AUDIT.md)). The v1 plan dropped the paid plan. | rule |
| 4 | Alert delivery: notification permission asked in context the first time a switch is turned on, then remote push from the server (the v1 API’s delivery path). Switches stay off by default. | The alert switches only record a choice today. | M |
| 5 | Real Pro product IDs and the AirHappy Pro subscription group in App Store Connect. Point the paywall’s Terms and Privacy links at the live URLs (they are `example.com` today). | Purchases cannot work with placeholder IDs. Review checks those links. | S + ops, Jason approves |
| 6 | Remove the internal-only switches from the public build: Pro unlock (`INTERNAL_PRO_UNLOCK`) and the Open-Meteo feed (`LIVE_OPEN_METEO`). | Both are on in Release for internal TestFlight only. | S |
| 7 | `support@airhappy.app` exists and is watched. `airhappy.app` serves `/support` and `/privacy`. | App Store Connect needs both URLs to load with no login. | ops |
| 8 | Recheck the privacy manifest and the App Privacy label against the public binary (sign-in, push token, purchases). | The label must match what the binary does. | S |
| 9 | Accessibility pass on a device: VoiceOver, the largest Dynamic Type, 4.5:1 contrast, no purple. | Review and our own bar. | S–M |
| 10 | Screenshots for the 6.9" and 6.5" iPhone sizes. The first one answers “When is it safe to be outside today?” | Required for the listing. | S |
| 11 | A Tamarack and Boise TestFlight beta with a handful of testers (v1 plan, week 3). External testers need Beta App Review. | Real use before review. | ops |

## P1 — after v1 (future intent)

| # | Task | Notes |
| --- | --- | --- |
| 1 | Widget: small, medium and large. | v1.1. Needs an App Group and a widget bundle ID. |
| 2 | iOS map. | v1.1. A regional wash needs a licensed style. Keep it off the main thread. |
| 3 | Per-place AQI threshold alert, off by default, notifying only on a crossing. | From the 2026-10-29 roadmap. Do not import the website’s silent `alertAt: 100`. |
| 4 | When In Use location to add the place you are in. Search beyond the Idaho list. | Search and the list must still work when location is denied. |
| 5 | Activity and weekend planner. | v1.1. |
| 6 | Background refresh and an offline last reading with its time. | Airplane mode must not look like a live number. |
| 7 | iPad layout and screenshots. | v1 is iPhone only. |
| 8 | Apple Watch and Apple TV apps. | After the iPhone app (Jason, 2026-11-02). |

## Website (separate from the app)

From the 2026-09-29 audit. Not rechecked against today’s site. The website map was removed on 2026-10-30, so the CARTO key item is gone.

| # | Task | Notes |
| --- | --- | --- |
| 1 | Set `VITE_PUBLIC_HOSTNAME` so `og:url` and the invite blurb use the public host. | Production env change. |
| 2 | Accessibility: nested buttons in cards, keyboard reorder, chart text alternative, `--color-subtle` and Hazardous contrast, reduced motion. | |
| 3 | Show and edit `alertAt`, or stop writing a silent default. | |
| 4 | Daily chart is an average; `primaryPollutant` prefers PM2.5. | |
| 5 | Clamp `/api/aqi` lat/lon. | |
| 6 | Retire the cleanup service worker. | |
| 7 | Narrow the 0.02° duplicate rule and name the place that collided. | |

## Not in this submission

- Capacitor or a WebView of the website
- Account sync beyond what the v1 API needs, multiplayer, social
- HealthKit, Always location, tracking
- Claiming AirNow equivalence for our forecast (the AirNow number stays separate and credited)
- Pollen, AI chat, a lifetime unlock (cut in the v1 plan)
