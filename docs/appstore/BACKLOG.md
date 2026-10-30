# Backlog — App Store refinement

Date: 2026-09-29. Revised 2026-10-29 to follow [ROADMAP.md](./ROADMAP.md). Source: [AUDIT.md](./AUDIT.md) and [IOS-PLAN.md](./IOS-PLAN.md).

Effort labels are the September draft, not the 32.5 Keel-day total. **S** is under a day. **M** is a few days. **L** is the native app itself. Items marked **ops** happen outside this repo (Apple, DNS, Vercel, a mailbox). This branch does not do them.

Do not start production changes from this list. v1 does not add an API key. Do not “fix” Guideline 4.2 by wrapping the website. Do not pick the app name, bundle ID, data stack, or price here.

## P0 — required before submission

| # | Task | Why it blocks review or launch | Effort |
| --- | --- | --- | --- |
| 1 | Enroll BBCVC as an Apple Developer **organization**. Bank the team Admin on the Mac Mini. | No organization team, no seller name, no distribution cert. Ops. Not part of the 32.5 Keel-days. | ops |
| 2 | Data stack stays **OPEN**. Do not buy a forecast plan, add a key, or change `/api/aqi` or `/api/geocode`. The audit records that a commercial Open-Meteo subscription is unresolved. That choice waits. | A company app may not fit the vendor’s non-commercial examples. Spending is outside this phase. | decision |
| 3 | A proxy gate (rate limit, App Attest, or equivalent) is required only if a later decision puts a paid key on the server. Never put a key in the iOS binary or the git repo. | The proxy is an open relay today. Do not start this production change for v1. | later |
| 4 | Publish https://bbcvc.dev/privacy from [LISTING.md](./LISTING.md), including a real mailing address, and https://bbcvc.dev/support with a monitored support@bbcvc.dev. | App Store Connect requires both URLs, loaded with no login. Ops. | S + ops |
| 5 | Build the SwiftUI app per [IOS-PLAN.md](./IOS-PLAN.md) and [ROADMAP.md](./ROADMAP.md): list, search, When-In-Use location, `CLGeocoder`, hourly forecast, 5-day daily maximum, visible threshold (off by default), local notifications, `BGAppRefreshTask`, WidgetKit small / medium / large, App Group. No map. iPhone only. iOS 17+. | This is the product that can clear Guideline 4.2. A Capacitor WebView cannot. | L |
| 6 | Thresholds are visible and default to **off** until the person opts in. Notify on a crossing, then stay quiet until the value falls back under the line. | `alertAt: 100` is stored today and never shown. Shipping a silent default that spams, or a control that does nothing, fails the alerts claim. | Part of 5 |
| 7 | About screen and store description: modeled US AQI, not AirNow, credited to whatever the live API uses today; links to the privacy policy and support URL on `bbcvc.dev`. | Licence attribution and Guideline 5.1.1. Do not write a vendor in as a permanent choice. The data stack is open. | S, inside the iOS about screen |
| 8 | Cache the last good reading and its timestamp. Airplane mode must not look like a live zero. | The PWA has no offline cache. Reviewers toggle network. | S, inside the App Group store |
| 9 | VoiceOver names for list, add, delete, and threshold. Dynamic Type does not clip the index. Text meets 4.5:1. Do not copy the website’s Very Unhealthy purple (`#9b5de5` in `src/lib/aqi.ts`) or Hazardous `#7f1d1d` on `#14191f` (about 1.8:1). | App Store accessibility review. No purple, violet, lavender, indigo, or magenta. | S–M, inside the SwiftUI UI |
| 10 | App Privacy answers match the binary, once pricing and the data stack are chosen. No ATT prompt. `PrivacyInfo.xcprivacy` matches the APIs you call. `ITSAppUsesNonExemptEncryption = false`. | A mismatch is a rejection. The September draft is not ready to paste while those decisions are open. | S |
| 11 | TestFlight on a physical iPhone: deny location, deny notifications, widget (three sizes), forced background refresh, 15-place cap, offline cache. Screenshots: home, place, search, threshold, widget. No map shot in v1. | Simulator hides the failures Apple will hit. | S–M on the Mac |
| 12 | Confirm production `VITE_AUTH_ENABLED` and that the iOS target does not include `/login`, the Grok banner, the Home Screen install guide, or the “Aether” string. | The website route still says “Sign in to Aether” and auth defaults on unless the flag is false. Production env was not read for this audit. | S to inspect env (ops) + do not copy those screens |

## P1 — not v1

| # | Task | Why | Effort |
| --- | --- | --- | --- |
| 1 | CARTO basemap API key for the **website** map, restricted to `aqi.burum.dev`, with OSM + CARTO attribution still visible. Or switch the PWA off the unkeyed `basemaps.cartocdn.com` style. | Terms (26 Aug 2026) require the customer’s own key. iOS v1 has no map, so this is not a store blocker. The website is still exposed. | S, production |
| 2 | Set `VITE_PUBLIC_HOSTNAME=aqi.burum.dev` on the Vercel build and point the install-guide share blurb at that host. | Live HTML still emits `og:url` = `https://aether-aqi.vercel.app/`. | S, production env — not in this branch |
| 3 | PWA accessibility: stop nesting buttons inside `role="button"`, make reorder keyboard-accessible, add a text alternative for the charts, lift `--color-subtle` and the Hazardous / Very Unhealthy contrast, honor reduced motion. | Real bugs on the website. Not store blockers for the native app. | M |
| 4 | Show and edit `alertAt` on the website, or stop writing a fake threshold. | Avoid two products that disagree. iOS must not import a silent `100` and start notifying. | S |
| 5 | Website daily chart: it is an average. iOS v1 shows the day’s maximum instead. Fix `primaryPollutant` so it does not always say PM2.5. | The website number is easy to misread during smoke. | S |
| 6 | Clamp `/api/aqi` lat/lon to a real range. Return 400 otherwise. | Minor abuse and bad-cache footgun. Production change, not this branch. | S |
| 7 | Retire the cleanup service worker once old clients are gone, so launches stop registering and unregistering `sw.js`. | Extra reload risk left over from a stale-cache incident. | S |
| 8 | iOS map, **v1.1**. Not in the first binary. A regional wash still needs a licensed style. Bundle ID is **OPEN**, so do not request a tile key for an id written in this folder. Keep any wash off the main thread. | The 2° lattice is a signature of the website and a performance hazard to port blindly. | M |
| 9 | Remote push only if device tests show background refresh is too slow. Update the privacy policy and nutrition label in the same release. | Reliability versus “we don’t upload the watchlist”. | M |
| 10 | Narrow the 0.02° duplicate rule and say which place collided. | Nearby sites cannot be saved. | S |
| 11 | iPad layout and screenshots. | v1 is iPhone-only on purpose. | M |

## Not in this submission

- Account sync, Better Auth, or the Grok broker
- Multiplayer / social (`src/lib/multiplayer/`)
- HealthKit
- Always-on location
- Claiming AirNow equivalence or shipping AirNow’s API
- Capacitor `server.url` pointed at production
- A v1 map, or removing the website map
- Choosing a name, bundle ID, data stack, or price
- Paid API signup and new launchd jobs
- Denser commercial heatmap tiles
- Rewriting the PWA in the same release as the first iOS binary

## Suggested order

1. Docs and the design set (phase 1). Name, bundle ID, data stack, and pricing stay open through M1.
2. SwiftUI vertical slice through widget and alerts (P0.5–P0.9). No map.
3. Privacy URLs on `bbcvc.dev` (P0.4) before submission. Ops.
4. Privacy label, screenshots, TestFlight, then submit (P0.10–P0.12), after the open decisions are actually made.
5. Website licence and canonical host (P1.1, P1.2) are not a substitute for the native app.
