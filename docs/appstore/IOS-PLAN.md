# iOS plan — native app that can clear Guideline 4.2

> **Updated 2026-10-29.** Follow [ROADMAP.md](./ROADMAP.md) when this file disagrees with it. v1 is SwiftUI on existing `GET /api/aqi` and `GET /api/geocode`, plus location, threshold alerts, and a widget (small, medium, large). **Map is v1.1.** **OPEN:** app name, bundle ID, data stack, pricing. Do not register an identifier or buy an API plan from this file. Company host is `bbcvc.dev`.

Date: 2026-09-29, revised 2026-10-29. Company: BBCVC (Apple Developer organization, not yet enrolled). The iOS build, signing, and TestFlight happen on a Mac with Xcode. This planning branch does not add an Xcode project.

The 2026-08-05 note [../IOS-APP-STORE.md](../IOS-APP-STORE.md) said to wrap https://aether-aqi.vercel.app in Capacitor and add native chrome later. Do not follow that. A remote WebView is the case Guideline 4.2 is written to reject, and this app’s server-rendered UI cannot be dropped into a `webDir` without still calling home to Vercel.

## Recommendation

**Build a SwiftUI client that calls the existing `GET /api/aqi` and `GET /api/geocode`. Ship location, a visible threshold control (off by default), and a WidgetKit extension (small, medium, and large) in the first binary. Keep the PWA on Vercel as the website, not as the app. Do not ship a map in v1.**

Why this one:

- Guideline **4.2 Minimum Functionality** asks for an app that is more than a repackaged website: its own UI, and utility that is not “open our URL”. A native list, forecast, home-screen widget, and alerts that fire when the web page is not open meet that bar. A map is not required for that bar and is **v1.1**. A WKWebView of `aqi.burum.dev` does not clear 4.2, even with a splash screen and a geolocation plugin.
- The v1 network surface is `GET /api/aqi` and `GET /api/geocode` only. Do not call `/api/aqi-grid` from v1. The watchlist is already a plain list of name, lat, lon, and `alertAt`.
- WidgetKit, `BGAppRefreshTask`, and `UNUserNotificationCenter` are Swift. Capacitor would still need an Xcode widget target and a background task. That is most of the native work, plus a WebView you then have to defend in review.
- The web build is TanStack Start + Nitro (`vite.config.ts` adds the Vercel preset only for `build`). There is no static export. `server.url = "https://aqi.burum.dev"` is a website. Bundling `.output` does not embed the API routes inside the phone.
- A new organization account’s first submission gets a careful read. The binary should look like a weather utility written for iOS: system font, Swift Charts, and a widget screenshot on the product page.
- v1 uses `CLGeocoder` for the place name, so it does not call BigDataCloud. It does not need the website’s CARTO style, because there is no map yet. The upstream behind `/api/aqi` is **OPEN**. The client does not call a forecast vendor directly, and this plan does not choose a paid key or a new provider.

The PWA stays the way it is until someone deliberately changes it. This plan does not add Capacitor, does not set `server.url`, does not change the Vercel build, and does not add an `ios/` tree.

## Options

| | Capacitor + plugins | SwiftUI client (recommended) | Hybrid: bundled WebView + Swift widget |
| --- | --- | --- | --- |
| What the reviewer opens | WKWebView of the site, or a bundled copy of the web UI that still fetches `/api/*` from Vercel | Native screens | WKWebView for the product, Swift only for the widget and maybe notifications |
| Guideline 4.2 | Weak. Remote URL is the usual rejection. Plugins (status bar, splash, geolocation) do not change that. | Strong, if the widget and alerts are real and the app works with both permissions denied. | Still a web wrapper. A widget helps the reply to a rejection; it does not make the main UI native. |
| Location | `@capacitor/geolocation` | Core Location, When In Use | Plugin or Core Location |
| Threshold alerts | Local notifications need a scheduled check. Background fetch plugins are best-effort and still depend on the web layer being alive. | `BGAppRefreshTask` reads saved places, hits `/api/aqi`, files a local notification. | Same native scheduler, plus a bridge so the WebView and the widget share storage. |
| WidgetKit | Not a Capacitor plugin. A Swift extension either way. | First-class. App Group with the app. | Same widget, extra bridging. |
| Background refresh | `UIBackgroundModes` `fetch` is flaky from JS. | `BGTaskScheduler` with a permitted identifier. | Native task, web UI out of the loop. |
| Offline | Only if you build a static shell and a cache. The cleanup service worker does not cache. | Cache the last successful payload in the App Group. | Must invent a cache the WebView does not have today. |
| Map | Current MapLibre + CARTO page, including the 2° wash and the main-thread raster. | Not in v1. v1.1 may add a map. A lattice wash needs a licensed style. Bundle ID is open, so do not name a tile-key restriction here. | Inherits the CARTO licensing gap. |
| Two UIs to maintain | One web UI, plus a thin Xcode project. | Website and iOS diverge. Shared contract is the JSON API, which is already stable. | Web UI plus Swift widget plus Capacitor config. Highest glue. |
| Fits this repo | Poor. SSR app, relative `/api` URLs, install guide that tells people to use Safari. | Good. iOS is a new `ios/` tree (created on the Mac) and does not affect `npm run build`. | `capacitor.config` would not change the web build, and was considered. It was skipped because it would point the team back at a WebView. |

### Native value that has to be in the first binary

These are product requirements, not a slide. If any of them is a stub, do not submit.

| Requirement | v1 implementation |
| --- | --- |
| Device location | When In Use. “Use my location” adds a place via `CLGeocoder` for the city name. Denying location still leaves search and the seeded list. v1 has no map. |
| Alerts when AQI crosses a threshold | Each place shows a threshold control. The switch is **off** until the person turns it on. Do not notify from the stored default `alertAt: 100`. Local notification from a background refresh, only after opt-in, and only on a crossing. No account. |
| WidgetKit | Small, medium, and large. US AQI, band word, and the time of the reading. Tap opens that place. Data comes from the App Group, written by the app and by the refresh task. |
| Background refresh | `BGAppRefreshTask`. The task identifier is **OPEN** until the bundle ID is chosen. It fetches saved places and reschedules the widget timeline. Do not turn on background modes you do not use. |

Remote push is not required for v1. Add it only if TestFlight shows local refresh is too late to be useful. Push means a server stores a device token and the watchlist, which changes the privacy label. See [LISTING.md](./LISTING.md).

## App identity

The 2026-09-29 draft filled these in (`llc.bbcvc.aqi`, “Air Quality Watchlist”, price free). Those picks are withdrawn.

| Item | Status |
| --- | --- |
| Display name | **OPEN.** Design mockups use the placeholder “Air Quality Forecast”. That placeholder is not the App Store name. |
| Bundle ID | **OPEN.** |
| Widget bundle ID | **OPEN.** It follows the app id. |
| App Group | **OPEN.** |
| SKU | **OPEN.** |
| Price | **OPEN.** Do not mark free or paid. v1 scope does not add IAP. |
| Data stack | **OPEN.** The client calls the live `/api/aqi` and `/api/geocode` only. |
| Apple team | BBCVC organization team, after enrollment. Ops. |
| Deployment target | iOS 17 or newer, when implementation starts. iPhone only for v1 (`TARGETED_DEVICE_FAMILY = 1`). |
| Category | Weather is the working fit for the copy. Confirm when the name is chosen. See [LISTING.md](./LISTING.md). |

Register the id on the organization account, not a personal team, once someone actually chooses it. Bundle IDs cannot move between teams later without pain. Do not register an id copied from an older draft of this file.

## Entitlements and capabilities

Enable only these. “Always” location is not one of them.

| Capability | Entitlement / setting | Why |
| --- | --- | --- |
| App Groups | `com.apple.security.application-groups` set to the App Group id on the app and the widget. The id is **OPEN** with the bundle ID. | Shared watchlist and last readings |
| Background Modes → Background fetch | `UIBackgroundModes` includes `fetch` | Opportunistic AQI check |
| Background Modes → Background processing | `UIBackgroundModes` includes `processing` | `BGProcessingTask` only if a refresh cannot finish in the fetch budget. Skip until TestFlight shows you need it. |
| Push Notifications | `aps-environment` | **Add when remote push exists.** Omit from the v1 archive if you ship local notifications only. A capability with no token flow invites review questions. |
| Time Sensitive Notifications | Communication Notifications / Time Sensitive entitlement | Optional, later, for Hazardous only. Needs a specific reason. Not v1. |
| Associated Domains | `applinks:aqi.burum.dev` | Optional. Universal links are not required to ship. |
| App Attest / DeviceCheck | DeviceCheck | Optional later gate, and only if a paid upstream key is added. Data stack is **OPEN**. Not a reason to put a vendor key in the binary. |

Do **not** enable HealthKit, Location Always, or tracking (`NSUserTrackingUsageDescription` / ATT). AQI advice stays in the app. It is not a clinical record.

Signing: Automatic signing, team BBCVC LLC. Development and distribution certificates live on the Mac Mini keychain (or in Xcode cloud later). Do not export them into this git repo.

## Info.plist and privacy manifest

Usage strings, exact text:

```text
NSLocationWhenInUseUsageDescription
Saves the place you are in. Air quality checks for saved places run without tracking you in the background. v1 has no map.

NSLocationAlwaysAndWhenInUseUsageDescription
(omit — do not request Always)
```

Other keys:

| Key | Value |
| --- | --- |
| `UIBackgroundModes` | `fetch` (and `processing` only if that task ships) |
| `BGTaskSchedulerPermittedIdentifiers` | **OPEN** until the bundle ID is chosen |
| `ITSAppUsesNonExemptEncryption` | `false` (HTTPS only, no custom crypto) |
| `UILaunchScreen` | Neutral dark from the design tokens. No purple cast. Wordmark uses the name once it is chosen. |
| `CFBundleDisplayName` | **OPEN** |
| `LSApplicationQueriesSchemes` | none |
| Photo, camera, contacts, microphone, Bluetooth, calendars | do not add |

`PrivacyInfo.xcprivacy` for the app target:

- Tracking: no. No tracking domains.
- Collected data types: match [LISTING.md](./LISTING.md) (precise location for app functionality, not linked to identity).
- Required-reason APIs: `UserDefaults` reason `CA92.1` if the App Group store uses `UserDefaults`. If you only write a JSON file in the group container, you may not need that reason. Declare whichever you actually call. Do not paste a blanket list.

Notification permission has no plist string. Ask in context, the first time someone sets a threshold: “Notify me when Boise reaches this AQI”. Provide the system prompt then. The app must be fully usable if they deny it.

## Architecture on the phone

```text
SwiftUI app (bundle ID OPEN)
  Core Location + CLGeocoder
  Swift Charts forecast
  UNUserNotificationCenter
        │
        ▼
  App Group (id OPEN)
  (places, thresholds, last AQI JSON)
        ▲
        │
Widget extension          BGAppRefreshTask
reads the group           GET https://aqi.burum.dev/api/aqi
                          writes the group, schedules local notifications,
                          WidgetCenter.reloadTimelines
```

API client rules:

- Base URL `https://aqi.burum.dev`. `aether-aqi.vercel.app` is the same Vercel app today; prefer the public hostname. Both were HTTP 200 on 2026-09-29.
- Reproduce the query shape in `src/routes/api/aqi.ts` and `src/routes/api/geocode.ts` so the website and the app stay compatible.
- Timeouts similar to the server (about 12s). Show the last cached reading with its timestamp when the network fails.
- Do not call a forecast vendor from the phone. Do not add a vendor key in this phase. The data stack is **OPEN**. See [ROADMAP.md](./ROADMAP.md) and [BACKLOG.md](./BACKLOG.md).
- Do not call BigDataCloud from the app.
- Do not call `/api/aqi-grid` from v1. That endpoint is the expensive one, and the map that uses it is v1.1.

AQI bands: copy the thresholds and the advice strings in `src/lib/aqi.ts` so the widget and the phone match the website. The daily figure on iOS is the day’s maximum hourly US AQI, not the website’s daily average. Keep the “modeled, not AirNow” line on the place screen and in the widget’s caption or the app’s about screen. Color tokens are not the website’s: Very Unhealthy on the web is purple (`#9b5de5`), and v1 does not use purple, violet, lavender, indigo, or magenta. The design PR specifies the tokens.

Suggested Xcode groups (created on the Mac, not in this repo yet):

| Group | Contents |
| --- | --- |
| `Features/Watchlist` | List, reorder, delete, add search, threshold editor |
| `Features/Forecast` | Hourly chips and 5-day daily maximum (Swift Charts) |
| `Features/Alerts` | Thresholds, notification authorization, copy. Control visible, switch off by default. |
| `Features/Map` | **v1.1.** Do not add this group for the first binary. |
| `Sync/AqiAPI` | URLSession client |
| `Sync/Store` | App Group persistence |
| `Sync/Refresh` | `BGAppRefreshTask` |
| `WatchlistWidget` | WidgetKit timelines |

## Guideline 4.2 — what to show Apple

Review guideline 4.2 (Minimum Functionality): the app needs features, content, and UI beyond a repackaged website. Related rules to design for at the same time:

- **2.5.4** Background modes must do what you told the system. The refresh task must fetch AQI, not keep a socket open.
- **5.1.1 / 5.1.2** Privacy policy URL, purpose strings, and nutrition labels match the binary.
- **5.1.5** Location is optional and explained.
- **4.5.4** If you later add push, the app still works without it.

Review notes (paste into App Store Connect):

> This is a native SwiftUI app from BBCVC. It is not a WebView of our website. The App Store name is not final. Saved places, thresholds, and the last readings are stored on device in an App Group. The app loads modeled US AQI from our existing API (not AirNow). v1 has no map. Test without an account. Location and notifications are optional: search still works if location is denied, and the list still works if notifications are denied. The home-screen widget reads the same on-device list. A background refresh updates readings and files a local notification only after the user turns a threshold on. The threshold control ships off. Sample places are preloaded. Privacy policy: https://bbcvc.dev/privacy. Support: https://bbcvc.dev/support.

Screenshots must include the widget and the threshold control, not only a phone frame of the website.

If a build is rejected under 4.2 anyway, reply with the widget, the background task identifier, and a screen recording of an alert firing from a saved place. Do not “fix” it by pointing `WKWebView` at the website.

## Mac Mini checklist

Do this on the Mac. Nothing here can be finished from the Linux agent.

### 0. Before Xcode

1. Enroll **BBCVC LLC** in the Apple Developer Program as an **organization**, not an individual. You need a D-U-N-S number, the legal entity name, and a person with authority to bind the company. The seller name on the store becomes BBCVC LLC. Budget the enrollment review; it is separate from app review. Cost is the current annual organization fee (historically US $99).
2. Publish the privacy policy and the support page from [LISTING.md](./LISTING.md) at `https://bbcvc.dev/privacy` and `https://bbcvc.dev/support`. Both must load with no login. App Store Connect rejects a missing privacy URL.
3. Do not subscribe to a forecast API and do not change `/api/aqi` or `/api/geocode`. The data stack is **OPEN**. See [ROADMAP.md](./ROADMAP.md).
4. On a Mac you control, install the current Xcode from the Mac App Store and open it once so it installs the iOS platform and command-line tools.

### 1. Identifiers (developer.apple.com → Certificates, Identifiers & Profiles)

1. Sign in as an Admin on the BBCVC team.
2. Wait until the bundle ID is chosen. The 2026-09-29 ids are withdrawn. Do not register them.
3. Then register the app id, the widget id, and the App Group, and enable the group on both ids.
4. Enable Background Modes on the app ID. Leave Push off until you implement it.

### 2. Project

1. Xcode → New Project → iOS → App. Product name is **OPEN** (do not ship the mockup placeholder as the product name without a decision). Team BBCVC. Organization identifier is **OPEN**. Interface SwiftUI, language Swift, leave Core Data off (use the App Group JSON / `UserDefaults` store). Tests can be on.
2. Deployment target iOS 17. iPhone only.
3. File → New → Target → Widget Extension. Include a live activity only if you mean it (not v1). Embed in the app. Activate the scheme when asked. Provide small, medium, and large families.
4. Both targets: Signing & Capabilities → Automatically manage signing → Team BBCVC. Add the App Group once its id is chosen.
5. App target → Background Modes → check Background fetch. Add the BGTaskScheduler identifier to Info.plist as above.
6. Add the location usage string. Confirm Always is absent.
7. Add `PrivacyInfo.xcprivacy`.
8. App icon: 1024×1024 PNG, no alpha, no rounded corners (the system masks it). Start from `public/icon-512.png` and rebuild at 1024. Dark tile is fine.
9. Launch screen: the neutral dark token from the design set. No purple cast.

### 3. Implement the vertical slice before polish

Build in this order so TestFlight is a real app early:

1. App Group store, seeded with the same four default places as `src/lib/locations-store.ts`.
2. AQI client against `https://aqi.burum.dev/api/aqi` and search against `/api/geocode`.
3. List, place detail, hourly chips, 5-day daily maximum, delete, reorder.
4. Add place: search and When-In-Use location + `CLGeocoder`.
5. Threshold editor, visible, switch off by default, then local notification permission only after opt-in.
6. `BGAppRefreshTask` that updates the group and notifies only on a crossing after opt-in (compare to the last notified reading so you do not alert every refresh while the value stays high).
7. Widget timeline from the group, in small, medium, and large.
8. About screen: modeled-data disclaimer, credit for the provider the live API uses today, link to the privacy policy and support URL on `bbcvc.dev`. Do not hard-code a vendor as a permanent choice.
9. Map is not in this slice. It is v1.1.

### 4. Run on a phone

The simulator is not enough for location permission, a home-screen widget, or background refresh.

1. Connect an iPhone, trust it, select it as the run destination, run the app scheme.
2. Walk the cases in the test list below.
3. For background refresh during development, Xcode can force a task: scheme → Debug → “Launch due to background fetch task”, or the debugger command `_simulateLaunchForTaskWithIdentifier` that Apple documents for `BGAppRefreshTask`. A real device left idle is the honest test.

### 5. Archive and TestFlight

1. Scheme → Any iOS Device (arm64). Product → Archive.
2. Organizer → Distribute App → App Store Connect → Upload. Automatic signing. Strip symbols as Xcode suggests.
3. Export compliance: answer that the app uses only exempt encryption (HTTPS). `ITSAppUsesNonExemptEncryption = false` keeps the dialog short on later builds.
4. App Store Connect → My Apps → New App. Platforms iOS. Name, bundle ID, and SKU come from the open decisions, not from this file. Primary language English (U.S.). User access: full access unless you need a limited role.
5. Wait until the build finishes processing. Internal TestFlight (Admin/Developer/Marketing roles on the team) does not need Beta App Review. Add the phones that will actually try the widget.
6. External testers need a short Beta App Review and “What to Test” notes. Use the review notes above.

### 6. Submit

1. Fill the version from [LISTING.md](./LISTING.md): description, keywords, support URL, marketing URL optional, privacy policy URL, age rating, App Privacy.
2. Screenshots for the iPhone size App Store Connect marks required (6.9-inch class as of this writing). Include home, place detail, search, the threshold control (shown off), and the widget. No map screenshot in v1.
3. Copyright `2026 BBCVC LLC`.
4. Age rating questionnaire: answers are in the listing doc. Do not opt into Made for Kids.
5. Add the build, release manually (do not auto-release the first version).
6. Submit. First review is often about a day and sometimes longer. Reply in Resolution Center; do not ship a WebView in response to a 4.2 note.

### Device test list

- Fresh install: four sample places load numbers.
- Search “Boise”, add, list stops at 15.
- Deny location: search still works. v1 has no map locate control.
- Allow location once: a place is added with a sensible city name, and no BigDataCloud host appears in a proxy log.
- Airplane mode: last reading and timestamp remain; UI does not pretend it is live.
- Fresh install shows the threshold control off, and no notification fires.
- Turn a threshold on below the current AQI: a notification appears after a forced refresh, and not again until the value drops and crosses again.
- Deny notifications: the list still works; the threshold row explains that alerts are off.
- Widget shows the same numbers as the app after a refresh.
- VoiceOver can add, delete, and set a threshold. Dynamic Type at the largest size does not clip the AQI number into another control.
- Category text meets 4.5:1. Do not reuse web Hazardous `#7f1d1d` on the dark surface, and do not use the web Very Unhealthy purple.
- About screen shows the modeled-data line and the licence credits.

## What this plan deliberately does not do

- Capacitor, Cordova, or a remote `server.url`
- A map in v1, and any removal of the website map
- Choosing the app name, bundle ID, data stack, or price
- A paid API, a new vendor, or new launchd jobs
- React Native / Flutter rewrite
- An Xcode project or Xcode build in this planning work
- DNS or Vercel changes in the planning branch
- Account sync, HealthKit, or “AirNow official” claims
- Always-on GPS
