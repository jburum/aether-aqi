# Air Quality Forecast — iOS development plan

## Product principle: forecast first

The **Forecast** view is the primary and most prominent screen in the app. Everything else is secondary.

- **Default screen.** The app launches into Forecast. It is the first tab (or the root view if there are no tabs) and the top of the navigation hierarchy.
- **Large hourly + daily US AQI forecast.** The screen leads with:
  1. Place name and the current US AQI (large number, category color and label).
  2. **Hourly forecast** — a prominent, scrollable chart/strip for the next 24–48 hours, color-coded by AQI category.
  3. **Daily forecast** — the next several days, each with a min–max AQI range bar and peak value.
  4. Secondary details below the fold: main pollutant, PM2.5 / PM10 / O₃, health advice.
- **Watchlist is secondary.** Saved places (up to 15) live in a second tab / sheet. Tapping a place opens that place's Forecast view. The watchlist is a way to switch places, not the home screen.
- Alerts (threshold notifications) and the home-screen widget support the forecast but do not replace it.
- Data caveat shown on the Forecast screen: values are modeled (Open-Meteo / Copernicus CAMS), not regulatory monitor readings.

## Structure

| Tab | Screen | Priority |
| --- | --- | --- |
| 1 (default) | Forecast (current place) | Primary |
| 2 | Watchlist (saved places → opens Forecast) | Secondary |
| — | Settings / alerts / about (sheet or tab 3) | Tertiary |

## Milestones

1. Scaffold current-AQI view (done in `ContentView.swift`; becomes the header of Forecast).
2. Add hourly + daily forecast to `AQIService` (Open-Meteo `hourly=us_aqi`, derive daily min/max/peak) and build `ForecastView` as the root/default tab.
3. Add `WatchlistView` as tab 2 with on-device storage (App Group, shared with widget).
4. Local threshold notifications via background refresh.
5. WidgetKit widget showing current AQI + short hourly trend.
6. TestFlight on a physical iPhone; App Store listing as "Air Quality Forecast".

## Open items

- Open-Meteo commercial plan decision (required before public launch).
- Final bundle id after BBCVC Apple Developer enrollment.
- Rename internal target/folder `AetherAQI` only if needed (display name already set).
