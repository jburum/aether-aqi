# AirHappy preview — 2026-11-03

Private preview on `opus/airhappy-preview`. Nothing here is deployed, published or submitted.

- **Build:** the iOS app from this branch (`opus/airhappy-rename` plus this folder), Xcode 27.2, iOS 27.2 Simulator, Debug.
- **Data:** sample data only (`-AQIScenario` and friends; see `ios/README.md`). Free unless noted; "Pro" shots use the local stub `-AQIProStub YES`. No StoreKit, no network.
- **Sizes:**
  - `iphone-6.7/`: iPhone 16 Plus, 1290 × 2796 (the App Store 6.7" size).
  - `iphone-6.1/`: iPhone 17e, 1170 × 2532 (390 × 844 points).
- **Recording:** `main-flow-iphone-6.1.mp4`, 54 s at 390 × 844. It shows home (USG), the timeline and outlook, Places, Alert settings, the paywall on an alert switch, then back.
- **Re-make:** `ios/AetherAQIUITests/PreviewScreens.swift`, scheme `AetherAQIScreenshots`, with `TEST_RUNNER_SCREENSHOT_DIR` set to the output folder (see `ios/README.md`, "Sheet screenshots").

## Screenshots

Each name is in both size folders.

| File | Screen | Launch |
| --- | --- | --- |
| `01-home-good.png` | Home: current air, category, tip, alerts | `good` |
| `02-home-good-timeline.png` | Home, scrolled: 48-hour timeline | `good` |
| `03-home-good-window-outlook.png` | Home, bottom: best time outside, outlook, official AirNow reading | `good` |
| `04-home-usg-smoke-alert.png` | Home: Unhealthy for Sensitive Groups, active smoke alert | `usg` |
| `05-home-hazardous-inversion.png` | Home: Hazardous, smoke and an upcoming inversion | `hazardous`, alerts `winter` |
| `06-home-moderate-ozone.png` | Home: Moderate, low-confidence ozone heads up | `moderate`, outlook `weekday`, alerts `ozone` |
| `07-home-empty.png` | Home: no forecast for this place yet | `empty` |
| `08-home-error.png` | Home: couldn't load | `error` |
| `09-home-loading.png` | Home: loading | `loading` everywhere |
| `10-alert-settings.png` | Alert settings sheet (all off) | `good` |
| `11-paywall-alerts.png` | Pro paywall from an alert switch | `good` |
| `12-places-free.png` | Places sheet on Free (one place, "Add a place with Pro") | `good` |
| `13-paywall-places.png` | Pro paywall from Places | `good` |
| `14-paywall-share.png` | Pro paywall from Share on an alert | `usg` |
| `15-add-a-place.png` | Add a place (bundled Idaho list, search) | `good`, Pro stub |
| `16-share-sheet.png` | System share sheet for the alert card | `usg`, Pro stub |

## Planned screens

Planned = `docs/appstore/ROADMAP.md` (v1), `docs/appstore/AIRHAPPY-LISTING.md`, and the Pro plan in `ios/AetherAQI/Model/Pro.swift`.

| Screen | Status | Notes |
| --- | --- | --- |
| Home / place detail (hero AQI, category, tip, slider) | Built | Sample data. |
| 48-hour timeline | Built | Sample NOAA cycle. |
| Best time outside | Built | |
| Outlook (tomorrow, weekend, days 3–7) | Built | |
| Official AirNow reading panel | Built | Credited and marked preliminary. |
| Alerts list on home (smoke, inversion, ozone) | Built | Our forecast only; no notifications. |
| Alert settings | Built | Saved on the phone. Pro gate opens the paywall. |
| Pro paywall | Built | Fixture prices $1.99 / $12.99. Terms and Privacy links are placeholders (see gaps). |
| Places list (pick, rename, delete) | Built | Free 1, Pro up to 5. |
| Add a place | Partial | Bundled Idaho list with search. No geocoding search (`/api/geocode`) yet. |
| Alert share card + share sheet | Partial | The card renders as a PNG; the share sheet's preview icon is blank (see gaps). |
| Empty / error / loading states | Built | |
| Live data (`/api/aqi`, `/api/geocode`) | Not built | Every screen runs on sample data. |
| Location permission ("When In Use") | Not built | No prompt or Info.plist string. |
| Onboarding / first run | Not built | Opens straight to Boise. |
| Notifications (permission, push) | Not built | Alert settings says the app doesn't send notifications yet. |
| Widgets (small, medium, large) | Not built | No widget target. |
| Settings / About (version, support, privacy, restore) | Not built | Restore is only on the paywall. |
| App icon and launch screen | Not built | No AppIcon set in the project. |
| Map | Not built | Cut to v1.1 by the roadmap. |

## Known gaps

1. **Sample data only.** Nothing calls the server yet, so no screen shows a real place's air today.
2. **Paywall links are placeholders.** Terms and Privacy point at `example.com` (`PaywallText` in `Pro.swift`). The listing draft says Privacy should be `https://airhappy.app/privacy` and Terms should be Apple's standard EULA. The drafts in `pages/` match that. Changing the two URLs waits on Jason's call on the domain.
3. **Support email isn't settled.** The pages and the listing say `support@airhappy.app`. The bbcvc.dev job said `support@bbcvc.dev`. Neither mailbox is confirmed here.
4. **Share sheet preview is blank** (`16-share-sheet.png`). `SharePreview` uses the SF Symbol `aqi.medium`, which shows as an empty white tile. The shared PNG itself is fine. A fix is to pass the rendered card as the preview image.
5. **The outlook repeats "Tomorrow"** on the weekend sample (`03-home-good-window-outlook.png`). It shows once under Outlook and again under This weekend, because Sunday is both. This needs a design call.
6. **No "Not medical advice" line in the app.** The 2026-11-01 build note asks for one near the forecast; it is on the Support and Privacy pages only.
7. **Pages promise features the app doesn't have yet.** Support and Privacy describe location, notifications and place search. They are written for v1, so they are fine for review but not for this build as is.
8. **ROADMAP.md still says Pricing is OPEN** and the place cap is 15. The app and listing use $1.99 / $12.99 and 5 places on Pro.
9. **Bundle ID and product IDs** are still `com.example.aetheraqi` placeholders, as asked.

## Support, Privacy and Terms drafts

In `pages/`: `support.html`, `privacy.html`, `terms.html` and `pages.css`. They are plain HTML with no build step, they open from the file system, and they're marked `noindex`.

- **Support and Privacy** use the same copy as the web app's `/support` and `/privacy` routes, which have been on main since PR #42. If one changes, change both.
- **Terms** is new. It points to Apple's standard EULA and states the subscription terms the paywall shows.
- **Where they go live:** `https://airhappy.app/support`, `/privacy`, and Terms through the EULA link. They aren't hosted anywhere, and no domain points at them.
