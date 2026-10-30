# Roadmap — iOS v1

Approved 2026-10-29 by Jason. This file is the scope. [IOS-PLAN.md](./IOS-PLAN.md) is the longer plan and follows this file when they disagree. [../IOS-APP-STORE.md](../IOS-APP-STORE.md) (Capacitor) is superseded.

## v1

A native SwiftUI client. Network calls stay on the API that already exists:

- `GET /api/aqi`
- `GET /api/geocode`

No new route, no change to those handlers, and no new upstream.

| Piece | v1 behavior |
| --- | --- |
| Places | List, place detail, add by search. Cap 15, same as the website. |
| Readings | Hero US AQI, category word, pollutant, and activity tip. Hourly chips. The five-day figure is the day’s **maximum** hourly US AQI. |
| Location | When In Use, to save the current place. Search still works if location is denied. |
| Threshold alerts | The control is on screen. The switch is **off** until the person turns it on. |
| Widget | Small, medium, and large. |

## Cut from v1

| Item | Where it went |
| --- | --- |
| Map | **v1.1** for iOS. Removed from the website. No MapKit, MapLibre, or `/api/aqi-grid` in the first binary. |

## Open — do not pick these here

| Decision | Status |
| --- | --- |
| App name | **OPEN.** Mockups use the placeholder “Air Quality Forecast”. That is not a name decision. The PWA title “Air Quality Watchlist” is not a name decision either. |
| Bundle ID | **OPEN.** No App ID, widget id, App Group, or SKU in this repo. |
| Data stack | **OPEN.** The client calls the two routes above. Which vendor feeds them is not chosen. Do not add a paid key or switch providers in this work. |
| Pricing | **OPEN.** Do not mark the app free or paid from this page. |

## Estimate

About **32.5 Keel-days** for v1. The map is not included. Docs are about 0.5 day and the design set is about 3, from the phase 1 request. The other rows split the remaining 29 so the total stays 32.5. They are a planning split, not a second estimate.

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

Outside this estimate, and not started by the docs or design work: an Xcode project, signing, Apple Developer enrollment, any spend, any paid API, data-source changes, and new launchd jobs. The website map is removed, separate from this iOS estimate.

## Milestone

M1 is the design set. Jason approves those mockups before implementation leaves M1. Capacitor is not a milestone.
