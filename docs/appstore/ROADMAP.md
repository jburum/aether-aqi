# Roadmap — AirHappy for iOS

As of 2026-11-06. This file is the scope and the record of what is decided. [IOS-PLAN.md](./IOS-PLAN.md) is the longer plan and follows this file when they disagree. The product scope comes from the locked v1 plan in SharedBrain (`Projects/aether-aqi/v1-plan.md`, ELT, 2026-10-30). [../IOS-APP-STORE.md](../IOS-APP-STORE.md) (Capacitor) is superseded.

## Where it stands

AirHappy is a native SwiftUI app (`ios/`). It is in **internal TestFlight only**. The public App Store is **on hold**: no App Review submission and no release until Jason says so.

| Build | Branch and commit | What is in it |
| --- | --- | --- |
| 0.1 (1) | `opus/airhappy-testflight` @ `09ba65a` | First signed upload. Sample air, Free. |
| 0.1 (2) | `opus/airhappy-testflight` @ `2f6caca` | Sample place is Tamarack Resort (Donnelly, Idaho) instead of Boise. Pro unlocked in the internal build. |
| 0.1 (3) | `opus/airhappy-testflight` @ `5b06cb9` | **Live air** from Open-Meteo at the place’s pin (current US AQI and the 48-hour timeline). Best window, outlook and alerts stay sample. Pro unlocked. |

Builds go to the **Phase 1** internal testing group in App Store Connect. They were built from the branch above, not from `main`.

## Decided

| Item | Decision |
| --- | --- |
| App name | **AirHappy** (Jason, 2026-11-01). The App Store Connect record is **AirHappy by BBCVC**, SKU `airhappy-ios`. The home-screen name is AirHappy. The store listing name is still a draft in [AIRHAPPY-LISTING.md](./AIRHAPPY-LISTING.md). |
| Publisher | BBCVC LLC, organization team in the Apple Developer Program. |
| Bundle ID | `dev.bbcvc.airhappy` (2026-11-05). Tests use `.tests` and `.uitests`. No widget id, App Group or Pro product IDs yet. |
| App icon | Combined valley-and-breath mark, v2 (2026-11-05). |
| Encryption | Exempt. `ITSAppUsesNonExemptEncryption` = `NO` (standard HTTPS only). |
| Privacy manifest | `PrivacyInfo.xcprivacy`: no tracking, no collected data, UserDefaults reason `CA92.1`. Recheck before a public build (see [BACKLOG.md](./BACKLOG.md)). |
| Pricing | Free, or AirHappy Pro at $1.99 a month or $12.99 a year (v1 plan). Purchases are **not live**: the product IDs are placeholders and no in-app purchase is set up in App Store Connect. The internal builds unlock Pro locally instead. |
| Data stack for launch | NOAA smoke model for days 1–2 at valley scale, EPA AirNow official readings shown unaltered and credited, PurpleAir as ground truth with the EPA correction (points not yet approved). Days 3–7 come from NOAA’s air quality forecast or are labeled regional and low-confidence. Keys stay on the server, never in the app. |
| Data in internal builds | Open-Meteo’s keyless air quality API (CAMS model, CC BY 4.0, credited on screen). Its free tier is non-commercial, so it is for testing only and is not the launch source. |

## v1 (what the app does now)

| Piece | v1 behavior |
| --- | --- |
| Home | Current air for the active place, with the whole-screen color shift. Our forecast and the official AirNow reading are separate. |
| 48-hour timeline | One bar per hour, drag to move through it. VoiceOver can step it by an hour. |
| Best window | The best time to be outside in the next 48 hours. |
| Outlook | Tomorrow and the weekend. Anything past about 2 days says “Regional and low-confidence”. |
| Alerts (Pro) | Smoke, winter inversion and summer ozone. Each switch is **off** until the person turns it on. Choices are stored on the phone; nothing is delivered yet. |
| Saved places | Free has one. Pro has up to 5. Added from a bundled list of Idaho places. |
| Share card (Pro) | A PNG of an alert to share. |
| Paywall | Free and Pro side by side, monthly and yearly, restore, renewal terms. |

## Next, before a public build

These are needed before App Review. The full list is in [BACKLOG.md](./BACKLOG.md).

- Wire the app to the v1 API (`/api/v1/*`) for NOAA and AirNow data. That needs sign-in or another way to identify the app to the server, because those routes need a user.
- Live alerts: notification permission asked in context, and delivery by remote push from the server (v1 plan, Phase 0). Alerts stay off by default. The privacy label gains the push token in the same release.
- Real Pro product IDs and the subscription group in App Store Connect.
- Support and privacy URLs live, and the listing and privacy label rechecked against the binary.

## Future intent (kept from the 2026-10-29 roadmap)

These are still wanted. They are not in v1, and none of them is dropped.

| Item | Status |
| --- | --- |
| Widget | Small, medium and large. **v1.1.** Needs an App Group and a widget bundle ID. |
| Map | **v1.1.** No MapKit, MapLibre or `/api/aqi-grid` in the first binary. A regional wash needs a licensed style. The website map was removed 2026-10-30. |
| Threshold alerts by AQI number | A per-place “tell me above this AQI” control, off by default, notifying only on a crossing. v1 ships the rule-based smoke, inversion and ozone alerts first. |
| Location | When In Use, to add the place you are in. Search and the place list must still work if it is denied. v1 adds places from a bundled list. |
| Place search | Search beyond the bundled Idaho list. |
| Activity and weekend planner | **v1.1.** |
| Background refresh and offline last reading | Keep the last good reading and its time; never show a stale number as live. |
| iPad layout | Later. v1 is iPhone only, portrait. |
| Apple Watch and Apple TV | After the iPhone app (Jason, 2026-11-02). |

## The 2026-10-29 estimate

Kept for reference. It was a planning split for the earlier `/api/aqi` client plan, before the v1 plan replaced that scope. It is not a current estimate.

| Slice | Keel-days |
| --- | --- |
| Docs (audit update and this roadmap) | 0.5 |
| Design tokens and 390×844 mockups | 3 |
| SwiftUI list, place detail, search | 8 |
| Location | 3 |
| Threshold alerts | 6 |
| Widget, three sizes | 6 |
| Dynamic Type, VoiceOver, contrast, TestFlight notes | 6 |
| **Total** | **32.5** |

## Not without Jason

- Submitting for App Review or releasing to the public App Store.
- Turning on live purchases.
- Spend, including PurpleAir points or a paid Open-Meteo plan.
- Putting any API key (AirNow, PurpleAir or other) in the app.
