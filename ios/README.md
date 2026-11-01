# iOS app

SwiftUI app for AQI v1 (see the locked plan in SharedBrain, `Projects/aether-aqi/v1-plan.md`). So far it
has:

- **Phase 1:** the home screen for the active saved place, with the whole-screen color shift and the 48-hour drag timeline.
- **Phase 2:** the best window, the Tomorrow and weekend outlook, alerts and alert settings.
- **Phase 3:** saved places (up to 5) and the Pro paywall.
- **Every part:** loading, empty and error states.

All data is sample or recorded fixture data. There is no network code, no API key and no signing set up.

## Requirements

- Xcode 16 or later (the project uses folder-synced groups, Xcode 16's project format).
- iOS 17 or later. iPhone only, portrait.

## Build and run in the simulator

Open `ios/AetherAQI.xcodeproj`, pick an iPhone simulator, and press Run. Signing is not needed for
the simulator.

From the command line, run these from the repo root:

```sh
xcodebuild -project ios/AetherAQI.xcodeproj -scheme AetherAQI \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -derivedDataPath ios/build build

xcrun simctl boot 'iPhone 16'
open -a Simulator
xcrun simctl install booted ios/build/Build/Products/Debug-iphonesimulator/AetherAQI.app
xcrun simctl launch booted com.example.aetheraqi
```

Use any iPhone simulator you have installed (`xcrun simctl list devices available`). The iPhone 16
screen is 390x844 points, which matches the design mockups.

Run the tests:

```sh
xcodebuild -project ios/AetherAQI.xcodeproj -scheme AetherAQI \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
```

## Sample screens

The app reads the screen to show from the `-AQIScenario` launch argument. Without one, it shows `good`.

| Scenario | Screen |
|---|---|
| `good`, `moderate`, `usg`, `unhealthy`, `very`, `hazardous` | Home for Boise at that level. `hazardous` has no AirNow reading. |
| `empty` | No air for the place yet (shows the "No place yet" state; deleting every saved place shows it too) |
| `error` | The load failed |
| `loading` | Stays on the loading state |

```sh
xcrun simctl terminate booted com.example.aetheraqi
xcrun simctl launch booted com.example.aetheraqi -AQIScenario error
xcrun simctl io booted screenshot home-error.png
```

In Xcode, the scheme's Run > Arguments tab lists `good`, `empty` and `error`. Tick one to use it.

The timeline has its own argument, `-AQITimeline`, so its states show while the rest of the home screen
is loaded. The scheme lists `empty` and `error`.

| Timeline | What it shows |
|---|---|
| `fixture` (default) | The recorded 12Z cycle, moved so the current hour matches the scenario's number. Hour 31 has no value. |
| `empty` | No hourly forecast for the place |
| `error` | The forecast request failed, with Try again |
| `loading` | Stays on the loading placeholder |

The app's clock is pinned to 2026-10-31 15:00 UTC (9 AM in Boise), three hours into that cycle, so the
fixture always reads as current.

## The 48-hour timeline

- **What it plots:** one bar per hour of our corrected NOAA smoke forecast, from the current hour to the 48-hour lead. It is cut the same way as `classifyForecastLead` in `src/lib/v1/rules.ts`: hour 48 is in, anything after it is out.
- **Data shape:** rows are `IssuedForecast` from `src/lib/v1/types.ts`. `ForecastTimeline` keeps the newest cycle's `noaa_smoke` / `day_1_2_valley` rows and drops the rest:
  - days 3–7 rows (`noaa_aqf`, `regional`)
  - off-hour times
  - repeats (the first row stays)
  - AQI outside 0–500

  A live provider only has to return those rows.
- **Missing hours:** an hour with no row is drawn as a hollow stub. Selecting it shows "No forecast" and the neutral field. No number is filled in.
- **Dragging:** dragging moves the number, level, pollutant and advice. The field color holds while the finger is down and crossfades on release (design/round2.html). While it holds, the number and pill are white, so they still clear 4.5:1. "Back to now" returns to the current hour.
- **VoiceOver:** the chart is one adjustable element. Swipe up or down to move one hour; it reads the time, the forecast AQI and the level.
- **AirNow reading:** the official AirNow reading stays in its own panel and does not move with the timeline.

## Best window and outlook

The two responses are decoded exactly as `GET /api/v1/places/:id/best-window` and `/outlook` return them (`docs/v1/PHASE2.md`). The fixtures were produced by running the back end's own `bestWindowFromHours` and `outlookFromHours` (`src/lib/v1/phase2.ts`). Both reads use our corrected forecast only, and the AirNow number never feeds either of them.

- **Best window.**
  - **What it shows:** "Best time outside", start to end in the place's local time, for example "9 AM to 9 PM" or "8 PM to Thu 12 PM". Below that are a swatch in the band color (`Theme.bar`), the peak corrected AQI and its band, and the forecast sources in words.
  - **No window:** `bestWindow: "none"` shows a calm line: "No forecast hours in the next 48 hours yet."
- **Outlook.**
  - **Cards:** one for Tomorrow, then This weekend with Saturday and Sunday. On a weekend those two read Today and Tomorrow, or Yesterday and Today, as the API sends them.
  - **Each card:** the worst and typical corrected AQI, and the band of the worst value.
- **Confidence labels.**
  - **Valley days:** days 1–2 say "Valley forecast".
  - **Days past 48 hours:** any day with an hour past 48 hours says "Regional and low-confidence" in words. It also gets a dashed, quieter card and lighter numbers, so it never looks like the valley forecast.
  - **Unknown values:** a label or confidence value the app doesn't know is also shown as low-confidence.
- **No data:** a day with `summary: "no data"` reads "No forecast for this day yet."
- **Errors:** each part loads on its own, and a failure shows "Try again" without hiding the rest of the screen.

Pick the canned responses with `-AQIOutlook`:

| Outlook | What it shows |
|---|---|
| `weekend` (default) | Saturday 9 AM, as the app's clock: a window from 9 AM to 9 PM, and tomorrow plus both weekend days in the valley |
| `weekday` | A Wednesday response: Thursday in the valley, Saturday regional and low-confidence, Sunday with no data |
| `none` | `bestWindow: "none"` with the weekend outlook |
| `error` | Both requests fail |
| `loading` | Both requests never answer |

## Alerts

The alert list is decoded exactly as `GET /api/v1/places/:id/alerts` returns it: `docs/v1/ALERTS.md` and `AlertsResponse` in `src/lib/v1/alerts.ts`, on `keel/aqi-p2-alert-rules` while PR #15 is in review. The body has `placeId`, `asOf`, `timeZone`, `through` and `alerts`. Each alert has `kind` (`smoke`, `inversion` or `ozone`), `fired`, `status`, `start`, an exclusive `end`, `severity` (`elevated`, `high` or `heads_up`), `source`, `confidence` and `reason`. The fixtures were produced by running the back end's own `smokeRule`, `inversionRule` and `ozoneRule`, assembled the way `readAlerts` does it.

What the home screen shows:

- **Order.** Active alerts come first, then upcoming ones by start time. Alerts that are quiet, already over, or missing a time are left out.
- **Each row.** The rule and severity ("Smoke · High"), Now or Upcoming, the time span in the place's zone ("5 PM to Thu 1 AM"), and the reason the rule gave.
  - Elevated and high borrow the USG and Unhealthy band colors for a small swatch.
  - A heads up, or anything at `low` confidence, says "Regional and low-confidence" in words and gets a dashed card.
- **No alerts.** An empty list shows one line: "No smoke, inversion or ozone alerts in the next 7 days."
- **Loading and errors.** Alerts load on their own, beside the timeline, best window and outlook. A stall or failure in one never holds back the others.

**Alert settings** opens from the alerts section. It has one switch each for smoke, winter inversion and summer ozone.

- **Off by default.** Every switch is off until the person turns it on (`docs/appstore/ROADMAP.md`).
- **Stored on the phone only.** The choice is saved in UserDefaults (`alerts.<rule>.enabled`).
- **Nothing sent.** There is no notification permission prompt, no push, no entitlement and no network call.
- **The list ignores the switches.** It shows alerts whether or not any switch is on. The switches only record what the person wants alerted on, for when alerts start being delivered.

Pick the canned response with `-AQIAlerts`:

| Alerts | What it shows |
|---|---|
| `smoke` (default) | Saturday 31 Oct: smoke active, high |
| `winter` | 2 Dec: smoke active (elevated), then a valley inversion that evening (upcoming) |
| `ozone` | 8 Jul: ozone on days 3–7, an upcoming heads up at low confidence |
| `empty` | Nothing active or upcoming |
| `error` | The request fails |
| `loading` | The request never answers |

Each response has its own `asOf`, and the rows read Now or Upcoming against that, not against the app's sample clock.

## Saved places

Tap the place name on the home screen, or "Add a place" when there is none, to open **Places**.

- **What you can do:** pick the active place, rename (swipe right, or the context menu), delete (swipe left), and add. The place line stays on the home screen in every state (loading, stalled, error, no air yet), so the list is always one tap away.
- **Adding:** you choose from a bundled list of 21 Idaho places (`idaho-places.json`). There is no geocoding service and no location permission.
- **A place is its location:** a place is the same place by its latitude and longitude, never by its editable name. A renamed place can't be added again or take a second slot.
- **Following the active place:** the home screen loads every section for the active place. A slow answer for a place you have just switched away from never replaces the new one. Sample air is Boise's for every place; only the name and time zone change.
- **The shape:** it follows `saved_place` (`docs/v1/WEEK1.md`) and `SavedPlace` in `src/lib/v1/types.ts`: `id`, `name`, `latitude`, `longitude`, `valley`, `alertAt`, `position` and `createdAt`.
- **Where they are kept:** `LocalPlacesProvider` keeps them on the phone, in UserDefaults, as JSON. A live provider makes the same calls to `GET`/`POST /api/v1/places` and `DELETE /api/v1/places/:id`.
- **Renaming is local only:** the API has no rename route yet.
- **Time zones:** each bundled place carries its zone, which isn't part of `saved_place`. North Idaho is Pacific time. The sample alerts and outlook come back in the selected place's zone, as the routes do with `?timeZone=`, so a Coeur d'Alene alert reads in Pacific time.

Limits:

| | |
|---|---|
| Cap | 5 places, the same as the server (`MAX_SAVED_PLACES`, `place_cap`). At 5, "Add a place" is disabled and the list says why: "You have 5 places, the most you can save. Delete one to add another." The store refuses a sixth on its own too. |
| Free | One place. Adding a second shows "Free includes one place. More places are part of Pro." On Free only the first place can be active, so places saved under Pro stay listed and marked Pro. |
| Pro | Adding a second place on Free opens the paywall (see Pro below). `-AQIProStub YES` starts the sample store as Pro. |

Deleting the active place makes the first remaining place active. Deleting the last one leaves the home screen on "No place yet", with an "Add a place" button.

## Pro and the paywall

Pro is $1.99 a month or $12.99 a year (v1-plan.md). It adds:

- smoke, inversion and ozone alerts
- up to 5 saved places
- the alert share card (see "Alert share card" below)

**Where the paywall opens:**

- **Turning on an alert.** Any switch in Alert settings, on Free, opens it with "Alerts are part of Pro". The switch stays off.
- **Adding a second place.** On Free, the Places list shows "Add a place with Pro".
- **Turning things off.** Always works.
- **After Pro lapses.** A switch turned on under Pro reads off.

**What the paywall shows:**

- Free and Pro side by side.
- Monthly and yearly plans, with prices from the store and the yearly saving worked out from them (45%).
- Subscribe and Restore purchases.
- The renewal terms.
- Terms of Use and Privacy Policy links. These are placeholder `example.com` addresses until the App Store listing exists.

**How purchases work:**

- **Behind one protocol.** Purchases go through `PurchaseProvider`.
- **The App Store.** `StoreKitPurchaseProvider` (StoreKit 2) counts only verified transactions, finishes them, and restores with `AppStore.sync()`.
- **Tests and default runs.** `FixturePurchaseProvider` gives the two plans and lets a test pick buy, cancel, pending or fail.
- **Choosing StoreKit.** Launch with `-AQIStore storekit` to use StoreKit.

**Entitlement:**

- **Where it comes from.** Reads follow `EntitlementResponse` in `src/lib/v1/entitlements.ts` (#19): `tier`, `product` (the plan key), `expiresAt`, `state` (`free`, `active`, `grace`, `expired` or `revoked`) and `pro`.
- **When it counts as Pro.** The app uses the server's rule (`effectiveEntitlement`):
  - `grace` stays Pro after `expiresAt`, for Apple's billing grace period.
  - `active` is Pro only while `expiresAt` is ahead.
  - `expired`, `revoked` and `free` are never Pro.
  - A state the app doesn't know follows the server's own `pro`.
- **The App Store path.** StoreKit reports a subscription in the billing grace period as `grace`, the same way.

**Placeholders and limits:**

- **Product IDs.** `com.example.aetheraqi.pro.monthly` and `com.example.aetheraqi.pro.yearly` are placeholders, like the bundle ID. `ProductIDs.planKey(for:)` and `productId(for:)` are the one mapping to the server's plan keys, `monthly` and `yearly`, which are the only products #19's verifier accepts. Real App Store IDs will change only the StoreKit side of that mapping.
- **Not changed.** There is no App Store Connect setup, no entitlements or capabilities file, and no In-App Purchase capability change.

To try StoreKit purchases in the simulator:

1. Open Edit Scheme > Run > Options.
2. Set StoreKit Configuration to `ios/AetherAQI.storekit`. It is a local test file with both plans.
3. Launch with `-AQIStore storekit`.

The file is not attached to the shared scheme, because that path could not be checked without Xcode.

## Alert share card

Every active or upcoming alert row has a **Share** button.

- **With Pro:** it opens the share sheet (ShareLink) with a PNG of the card. The card is rendered with ImageRenderer at 3×, so the image is 1080 × 1350. It renders only when the person shares.
- **On Free:** it opens the paywall with "Sharing alerts is part of Pro".

The card (`AlertShareCardView`, built from `AlertShareCard`) shows:

- the place
- the alert kind, severity and status
- the time window in the place's zone
- our corrected peak, as a big number in its band's color
- "Our forecast, not an official reading.", plus "Regional and low-confidence." for a heads up

When the place has an AirNow reading, it sits in its own panel. That panel uses plain digits, is marked Preliminary, and carries the EPA credit, as on the home screen.

The only name on the card is the mockups' "Air Quality Forecast" placeholder.

The corrected peak is the alert's `peakAqi` (docs/v1/ALERTS.md, #21). An alert driven by AirNow has `peakAqi` null, so the card shows no corrected number for it and takes its color from the severity. The official number only ever appears in the AirNow panel.

## Layout

| Path | What it holds |
|---|---|
| `AetherAQI/App` | The app entry point |
| `AetherAQI/Model` | AQI levels and colors, the snapshot types, and `ForecastTimeline`. Our corrected forecast and the official AirNow reading are separate types. |
| `AetherAQI/Data` | `AirDataProvider` (the protocol the screens use), `FixtureForecastProvider` (recorded rows) and `SampleAirProvider` (fixed Boise data) |
| `AetherAQI/Home` | The home screen, the timeline and their model |
| `AetherAQI/Resources/Fixtures` | `boise-hourly-12z.json`: one NOAA 12Z cycle as `IssuedForecast` rows. `boise-best-window*.json`, `boise-outlook-*.json` and `boise-alerts-*.json`: Phase 2 responses. `idaho-places.json`: places to add |
| `AetherAQI/Design` | Tokens and fonts |
| `AetherAQI/Resources/Fonts` | Source Serif 4 and Source Sans 3 (SIL OFL, see `OFL.txt`) |
| `AetherAQITests` | Swift Testing unit tests |

## Design source

- **Colors.** These come from `design/round2-tokens.html` and `design/round2.html` (Round 5). Each level tints the whole screen with one field color, and white text stays at 4.5:1 or better on every field. The number and the level word use the level accent. The spectrum bar runs green to maroon. There is no purple anywhere, and the tests check that.
- **Neutral states.** Loading, empty and error use the neutral dark field (`--dark-bg` in `design/tokens.css`). That way no color ever stands for a number that isn't on screen.
- **Fonts.** The fonts are `design/fonts`, converted from WOFF2 to TrueType, because iOS can't load WOFF2 from the app bundle. The number uses Source Serif 4 at weight 800; the text uses Source Sans 3.
- **Official vs. our number.** The official AirNow reading has its own panel. Its number is plain white sans, not the level color. It is labeled Preliminary and carries the EPA credit line. The big number is always ours, labeled "Our forecast now".

## Placeholders

- **App name and bundle ID.** The name "Air Quality Forecast" and the bundle ID `com.example.aetheraqi` are placeholders. Both are still open in `docs/appstore/ROADMAP.md`.
- **App icon.** There is none yet.
- **Alert delivery.** Alert settings only save the person's choice on the phone. Notifications, the permission prompt and push wait for a later slice.
