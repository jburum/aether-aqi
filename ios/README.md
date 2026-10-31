# iOS app (Phase 0 shell)

SwiftUI app for AQI v1 (see the locked plan in SharedBrain, `Projects/aether-aqi/v1-plan.md`). Phase 0 is the
Free home screen only: current air for one place, the whole-screen color shift, a best-window placeholder,
and loading, empty and error states. All data is sample data. There is no network code, no API key and no
signing set up.

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

## Layout

| Path | What it holds |
|---|---|
| `AetherAQI/App` | The app entry point |
| `AetherAQI/Model` | AQI levels and colors, and the snapshot types. Our corrected forecast and the official AirNow reading are separate types. |
| `AetherAQI/Data` | `AirDataProvider` (the protocol the screens use) and `SampleAirProvider` (fixed Boise data) |
| `AetherAQI/Home` | The home screen and its model |
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
- **Best window.** The best-window line reads "Not ready yet". The real window arrives in Phase 2.
