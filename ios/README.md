# iOS app

SwiftUI app for AQI v1 (see the locked plan in SharedBrain, `Projects/aether-aqi/v1-plan.md`). So far it
is the Free home screen: current air for one place, the whole-screen color shift, the 48-hour drag
timeline (Phase 1), the best window and the Tomorrow and weekend outlook (Phase 2), and loading, empty
and error states. All data is sample
or recorded fixture data. There is no network code, no API key and no signing set up.

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
| `empty` | No place set |
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

## Layout

| Path | What it holds |
|---|---|
| `AetherAQI/App` | The app entry point |
| `AetherAQI/Model` | AQI levels and colors, the snapshot types, and `ForecastTimeline`. Our corrected forecast and the official AirNow reading are separate types. |
| `AetherAQI/Data` | `AirDataProvider` (the protocol the screens use), `FixtureForecastProvider` (recorded rows) and `SampleAirProvider` (fixed Boise data) |
| `AetherAQI/Home` | The home screen, the timeline and their model |
| `AetherAQI/Resources/Fixtures` | `boise-hourly-12z.json`: one NOAA 12Z cycle as `IssuedForecast` rows. `boise-best-window*.json` and `boise-outlook-*.json`: Phase 2 responses |
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
- **Alert settings.** Not built yet. They wait for the back end's alert-rules API.
