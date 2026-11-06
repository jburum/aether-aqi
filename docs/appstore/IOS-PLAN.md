# iOS plan — AirHappy, a native app that can clear Guideline 4.2

As of 2026-11-06. Follow [ROADMAP.md](./ROADMAP.md) when this file disagrees with it. First written 2026-09-29 for an `/api/aqi` watchlist client. That client plan was replaced by the locked v1 plan (SharedBrain `Projects/aether-aqi/v1-plan.md`, 2026-10-30). The app itself is described in [../../ios/README.md](../../ios/README.md).

## Recommendation (unchanged)

**Ship a SwiftUI app, not a WebView of the website.** Guideline 4.2 (Minimum Functionality) rejects an app that is a repackaged website. The 2026-08-05 Capacitor note ([../IOS-APP-STORE.md](../IOS-APP-STORE.md)) is superseded. Do not answer a 4.2 note by pointing `WKWebView` at the site.

What AirHappy shows a reviewer that a website wrapper cannot:

- Native screens: the color-shifted home, a 48-hour timeline you drag, the best window, the outlook with confidence labels, saved places, a share card.
- Alerts for smoke, winter inversions and summer ozone that reach the person when the app is closed (once delivery ships; see [BACKLOG.md](./BACKLOG.md)).
- StoreKit 2 subscriptions with restore.
- Later: a home-screen widget (v1.1).

## Identity

| Item | Value |
| --- | --- |
| Display name | AirHappy |
| App Store Connect record | AirHappy by BBCVC, SKU `airhappy-ios` |
| Bundle ID | `dev.bbcvc.airhappy` |
| Team | BBCVC LLC (organization). Automatic signing. |
| Version | 0.1, builds 1–3 so far |
| Deployment target | iOS 17 or later. iPhone only, portrait. |
| Widget bundle ID, App Group | Not yet. They come with the widget (v1.1). |
| Pro product IDs | Placeholders (`com.example.aetheraqi.pro.monthly` / `.yearly`). Real IDs need Jason. |
| Category | Weather, with Health & Fitness second ([AIRHAPPY-LISTING.md](./AIRHAPPY-LISTING.md)). |

## Architecture on the phone

```text
SwiftUI screens (Home, Timeline, Best window, Outlook, Alerts, Places, Paywall)
        │
        ▼
AirDataProvider ── SampleAirProvider        recorded fixtures (Debug, tests, screenshots)
               ├── OpenMeteoAirProvider     internal TestFlight only (LIVE_OPEN_METEO)
               └── (next) v1 API provider   GET /api/v1/places/:id/... on our server

SavedPlacesProvider ─ LocalPlacesProvider   UserDefaults JSON on the phone
PurchaseProvider ─ StoreKitPurchaseProvider / FixturePurchaseProvider
```

- **Where the code is.** The TestFlight work (bundle ID, signing, Tamarack, the Open-Meteo provider) is on `opus/airhappy-testflight` until it merges.
- **Screens never call a vendor by name.** They use `AirDataProvider`. Swapping the data source changes one provider.
- **The v1 API is the launch source.** Its responses are what the fixtures were recorded from (`docs/v1/`). NOAA, AirNow and PurpleAir keys stay on the server.
- **Open-Meteo is internal only.** Build 3 calls `air-quality-api.open-meteo.com` from the phone with no key, credits it on screen, and treats it as a model, not a monitor. The free tier is non-commercial.
- **Our number and the official number stay apart.** The big number is “Our forecast now”. The AirNow reading has its own panel, plain digits, marked Preliminary, with the EPA credit.
- **Saved places** stay on the phone today. The v1 API has the same shape (`GET`/`POST /api/v1/places`, `DELETE /api/v1/places/:id`).
- **Internal switches** (Release only, internal builds): `INTERNAL_PRO_UNLOCK` turns Pro on locally, and `LIVE_OPEN_METEO` turns on the Open-Meteo feed. Both come out before a public build.

## Entitlements and capabilities

Enable only what the binary uses.

| Capability | Now | Later |
| --- | --- | --- |
| In-App Purchase | Code is in place (StoreKit 2). No products in App Store Connect. | Real subscription group, with Jason’s approval. |
| Push Notifications (`aps-environment`) | Off | With alert delivery, which is remote push from the server in v1. Add it in the same build as the token flow; a capability with no token flow invites review questions. |
| App Groups | Off | With the widget (v1.1), shared by the app and the widget. |
| Background Modes (fetch) | Off | Only if a refresh task ships. Do not turn on modes the app does not use (2.5.4). |
| Location When In Use | Off (places come from a bundled list) | When “add where I am” ships. Never Always. |
| Associated Domains | Off | Optional, for links to `airhappy.app`. |

Do **not** enable HealthKit, Location Always, or tracking (no ATT prompt). AirHappy forecasts air quality; it is not medical advice.

## Info.plist and privacy manifest

| Key | Value |
| --- | --- |
| `ITSAppUsesNonExemptEncryption` | `NO` (HTTPS only, no custom crypto) |
| `NSLocationWhenInUseUsageDescription` | Not present yet. Add it with the location feature. |
| `PrivacyInfo.xcprivacy` | No tracking, no collected data, UserDefaults reason `CA92.1` |

Recheck the manifest and the App Privacy label when sign-in, push or purchases ship. [AIRHAPPY-LISTING.md](./AIRHAPPY-LISTING.md) has the label draft for the full v1, and it says which rows drop out while places stay on the phone.

Ask for notification permission in context, the first time someone turns on an alert. The app must work if they deny it.

## Building and uploading to TestFlight

Done on the Mac mini with Xcode. Signing material stays in the Mini’s keychain, never in this repo.

1. Bump `CURRENT_PROJECT_VERSION` on every target.
2. The BBCVC team has no registered devices, so a signed archive fails. Archive unsigned instead:

   ```sh
   xcodebuild -project ios/AetherAQI.xcodeproj -scheme AetherAQI -configuration Release \
     -destination 'generic/platform=iOS' -archivePath <out>/AirHappy.xcarchive \
     CODE_SIGNING_ALLOWED=NO archive
   ```

3. Let the export sign it for App Store Connect and upload it. The export options are `method` `app-store-connect`, `destination` `upload`, the BBCVC `teamID`, `signingStyle` `automatic`, `testFlightInternalTestingOnly` `true`, `uploadSymbols` `true`, `manageAppVersionAndBuildNumber` `false`:

   ```sh
   xcodebuild -exportArchive -archivePath <out>/AirHappy.xcarchive \
     -exportOptionsPlist <ExportOptions.plist> -exportPath <out>/export -allowProvisioningUpdates
   ```

4. In App Store Connect, once the build is Ready to Test, add it to the **Phase 1** internal group. Internal testers need Admin, Developer or Marketing roles and do not need Beta App Review.

`testFlightInternalTestingOnly` keeps these builds out of external testing and review. A public build drops it and goes through the P0 list in [BACKLOG.md](./BACKLOG.md) first.

## Guideline notes for review

- **4.2** Native UI and real alerts, not a website.
- **2.5.4** Background modes only if they do what we said.
- **3.1.2** Subscriptions: renewal terms on the paywall, restore, and a Terms of Use link.
- **5.1.1 / 5.1.2** Privacy policy URL, purpose strings and the privacy label match the binary.
- **5.1.5** Location is optional and explained, when it ships.

Review notes, to fill in for the public build (do not paste until the P0 list is done):

> AirHappy is a native SwiftUI app from BBCVC LLC, not a WebView. It forecasts air quality for saved places in Idaho for the next 48 hours, with a week outlook marked low-confidence past two days. The big number is our forecast; the EPA AirNow reading is shown separately, unaltered, marked preliminary and credited. Alerts for smoke, inversions and ozone are off until the person turns them on. AirHappy Pro is an auto-renewing subscription with restore. Privacy: https://airhappy.app/privacy. Support: https://airhappy.app/support.

## Device test list

- Fresh install: the default place loads, and every section has a loading, empty and error state.
- Drag the timeline; “Back to now” returns. VoiceOver steps the timeline by one hour.
- Our number and the AirNow number never mix. The AirNow panel says Preliminary and credits the EPA.
- Days past 48 hours say “Regional and low-confidence” in words.
- Every alert switch is off on a fresh install. Denying notifications leaves the app usable.
- Free: one place; adding a second, turning on an alert, or sharing an alert opens the paywall.
- Pro (StoreKit sandbox, once products exist): buy, cancel, restore, and a lapsed subscription turns alerts off.
- Airplane mode: no fake live number.
- Largest Dynamic Type does not clip the number into other controls. Text meets 4.5:1. No purple.

## What this plan does not do

- Capacitor, Cordova, or a WebView of the website
- Keys for AirNow, PurpleAir or any vendor in the app
- Submitting for review, releasing, or turning on live purchases without Jason
- A map or widget in v1 (both v1.1)
- HealthKit, Always location, or tracking
