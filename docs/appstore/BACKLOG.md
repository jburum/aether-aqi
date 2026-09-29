# Backlog — App Store refinement

Date: 2026-09-29. Source: [AUDIT.md](./AUDIT.md) and [IOS-PLAN.md](./IOS-PLAN.md).

Effort is focused engineering or admin time, not a calendar commitment. **S** is under a day. **M** is a few days. **L** is the native app itself, more than one slice of work. Items marked **ops** happen outside this repo (Apple, DNS, Vercel, a mailbox). This planning branch does not do them.

Do not start P1 work that touches production until the P0 licence and privacy URLs exist. Do not “fix” Guideline 4.2 by wrapping the website.

## P0 — required before submission

| # | Task | Why it blocks review or launch | Effort |
| --- | --- | --- | --- |
| 1 | Enroll BBCVC LLC as an Apple Developer **organization**. Bank the team Admin on the Mac Mini. | No organization team, no seller name, no distribution cert. | ops |
| 2 | Buy Open-Meteo API Standard (commercial licence, about $29/month for 1M calls — confirm on Stripe) **or** get written confirmation that this company app may stay on the non-commercial tier. Point the server proxy at `customer-api.open-meteo.com` with the key in server env only. | A LLC store app matches their “commercial product” example. The free tier is non-commercial and capped at 10k calls/day. The map grid can spend that quickly. | S once the key exists, plus ops |
| 3 | Before that key is live, gate `/api/aqi`, `/api/geocode`, and `/api/aqi-grid` (rate limit, and App Attest or an equivalent if anonymous traffic would burn the budget). Never put the key in the iOS binary or the git repo. | The proxy is an open relay today. A public commercial key will be scraped. | M, and it is a production change — separate from this docs PR |
| 4 | Publish https://bbcvc.llc/privacy from [LISTING.md](./LISTING.md), including a real mailing address, and https://bbcvc.llc/support with a monitored support@bbcvc.llc. | App Store Connect requires both URLs, loaded with no login. | S + ops |
| 5 | Build the SwiftUI app on the Mac Mini per [IOS-PLAN.md](./IOS-PLAN.md): list, search, When-In-Use location, `CLGeocoder`, hour/day forecast, MapKit pins, editable threshold, local notifications, `BGAppRefreshTask`, WidgetKit, App Group. iPhone only. iOS 17+. | This is the product that can clear Guideline 4.2. A Capacitor WebView cannot. | L |
| 6 | Thresholds are visible and default to **off** until the person opts in. Notify on a crossing, then stay quiet until the value falls back under the line. | `alertAt: 100` is stored today and never shown. Shipping a silent default that spams, or a control that does nothing, fails the “alerts” claim in the listing. | Part of 5 |
| 7 | About screen and store description: modeled CAMS / Open-Meteo US AQI, not AirNow; CC BY 4.0 credit; Copernicus credit; links to the privacy policy and support URL. | Licence attribution, and Guideline 5.1.1. The website only shows the disclaimer inside an expanded card. | S, inside the iOS about screen |
| 8 | Cache the last good reading and its timestamp. Airplane mode must not look like a live zero. | The PWA has no offline cache. Reviewers toggle network. | S, inside the App Group store |
| 9 | VoiceOver names for list, add, delete, threshold, map pins. Dynamic Type does not clip the index. Hazardous and secondary text meet contrast (do not copy web `#7f1d1d` on `#14191f`, about 1.8:1). | App Store accessibility review and the broken web tokens. | S–M, inside the SwiftUI UI |
| 10 | App Privacy answers exactly as in [LISTING.md](./LISTING.md). No ATT prompt. `PrivacyInfo.xcprivacy` matches the APIs you call. `ITSAppUsesNonExemptEncryption = false`. | A mismatch is a rejection and a trust problem. | S |
| 11 | TestFlight on a physical iPhone: deny location, deny notifications, widget, forced background refresh, 15-place cap, offline cache. Screenshot list, forecast, map, widget, and the threshold control at the required iPhone size. | Simulator hides the failures Apple will hit. | S–M on the Mac |
| 12 | Confirm production `VITE_AUTH_ENABLED` and that the iOS target does not include `/login`, the Grok banner, the Home Screen install guide, or the “Aether” string. | The website route still says “Sign in to Aether” and auth defaults on unless the flag is false. Production env was not read for this audit. | S to inspect env (ops) + do not copy those screens |

## P1 — after a build is in TestFlight, before or just after v1

| # | Task | Why | Effort |
| --- | --- | --- | --- |
| 1 | CARTO basemap API key for the **website** map, restricted to `aqi.burum.dev`, with OSM + CARTO attribution still visible. Or switch the PWA off the unkeyed `basemaps.cartocdn.com` style. | Terms (26 Aug 2026) require the customer’s own key. The iOS v1 map uses MapKit and does not need this for submission. The website is still exposed. | S, production |
| 2 | Set `VITE_PUBLIC_HOSTNAME=aqi.burum.dev` on the Vercel build and point the install-guide share blurb at that host. | Live HTML still emits `og:url` = `https://aether-aqi.vercel.app/`. | S, production env — not in this branch |
| 3 | PWA accessibility: stop nesting buttons inside `role="button"`, make reorder keyboard-accessible, add a text alternative for the charts, lift `--color-subtle` and `--color-aqi-hazardous` contrast, honor reduced motion. | Real bugs, not store blockers for a native rewrite. | M |
| 4 | Show and edit `alertAt` on the website, or stop writing a fake threshold. | Avoid two products that disagree. iOS must not import a silent `100` and start notifying. | S |
| 5 | Daily chart: label it as an average, or chart the day’s maximum hourly US AQI. Fix `primaryPollutant` so it does not always say PM2.5. | The number is easy to misread during smoke. | S |
| 6 | Clamp `/api/aqi` lat/lon to a real range. Return 400 otherwise. | Minor abuse and bad-cache footgun. | S |
| 7 | Retire the cleanup service worker once old clients are gone, so launches stop registering and unregistering `sw.js`. | Extra reload risk left over from a stale-cache incident. | S |
| 8 | Regional AQI wash on iOS, only with a licensed style (CARTO key restricted to `llc.bbcvc.aqi`, or another provider). Keep it off the main thread. | The 2° lattice is a signature of the website and a performance hazard to port blindly. | M |
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
- Denser commercial heatmap tiles
- Rewriting the PWA in the same release as the first iOS binary

## Suggested order

1. Apple organization enrollment and the two public URLs (P0.1, P0.4) start immediately; they do not depend on code.
2. Open-Meteo subscription and the proxy gate (P0.2, P0.3) before any external TestFlight build, so the phone is not hammering the free tier.
3. SwiftUI vertical slice through widget and alerts (P0.5–P0.9) on the Mac Mini.
4. Privacy label, screenshots, TestFlight, then submit (P0.10–P0.12).
5. Website licence and canonical host (P1.1, P1.2) in parallel if someone else can touch Vercel. They are not a substitute for the native app.
