# AirHappy — App Store listing draft

| | |
| --- | --- |
| **Status** | DRAFT, 2026-11-02. Not entered in App Store Connect. Nothing submitted or published. |
| **Publisher** | BBCVC LLC (Apple Developer account) |
| **Primary question** | "When is it safe to be outside today?" |
| **Pricing** | Free download. AirHappy Pro: $1.99/month or $12.99/year (auto-renewing) |
| **Pages** | `/support` (`src/routes/support.tsx`) and `/privacy` (`src/routes/privacy.tsx`) |
| **SharedBrain** | To be filed as `Projects/aether-aqi/app-store-listing-draft.md`. This file is the reviewed copy. |

Character counts were checked against Apple's limits: name 30, subtitle 30, promotional text 170, keywords 100, description 4000.

## App name (30)

**Recommended: `AirHappy: Smoke & Air Quality`** (29)

The name field is searchable. Adding "Smoke & Air Quality" puts two core search terms in the most heavily weighted field, and the name on the home screen stays "AirHappy".

Fallback: `AirHappy` (8).

## Subtitle (30)

**Recommended: `Is it safe to be outside?`** (25)

Alternatives:
- `Smoke forecast for your valley` (30)
- `Best hours to run in smoke` (26)

## Promotional text (170)

> Smoke season, planned. See the cleanest hours today to run, ride, or let the kids play outside, from NOAA smoke forecasts corrected for your valley.

(148) Promotional text can change any time without a new review, so it can be retuned during fire season.

## Keywords (100)

```
AQI,wildfire,inversion,run,hiking,ozone,PM2.5,haze,fire,forecast,pollution,asthma,outdoor,Idaho
```

(95)

- **Left out on purpose:** words already in the recommended name and subtitle (smoke, air, quality, safe, outside). Apple already indexes those.
- **Format:** comma-separated with no spaces, because spaces count toward the limit.
- **Jason's terms:** smoke, air quality, AQI, wildfire, inversion and run are all covered.
- **Later:** revisit "Idaho" when the app expands beyond Valley County into the wider Western smoke belt.

## Description (4000)

> When is it safe to be outside today?
>
> AirHappy answers that one question for the places you care about. Before a run, a bike ride, a hike, or recess, open the app and see the cleanest window of the day, hour by hour.
>
> BUILT FOR SMOKE SEASON
> • Hour-by-hour smoke and air quality for today and tomorrow, from NOAA's valley-scale smoke model and corrected for your valley.
> • The best window to be outside, picked for you.
> • A week-ahead outlook from NOAA's air quality forecast, clearly marked when confidence is low.
> • Inversion warnings for valleys where cold air traps smoke near the ground.
>
> THE OFFICIAL NUMBER, SIDE BY SIDE
> AirHappy shows the latest official reading from the U.S. EPA AirNow program next to its forecast. It's always a separate number, credited to AirNow and marked preliminary, so you can see both.
>
> ALERTS (PRO)
> Get a heads-up when smoke, an inversion, or ozone is on the way for a saved place. Every alert is off until you turn it on.
>
> FREE AND PRO
> • Free: one saved place, with current air, the 48-hour timeline, the best window to be outside, and the week's outlook.
> • AirHappy Pro: up to five saved places, plus smoke, inversion, and ozone alerts.
>
> PRIVATE BY DESIGN
> No ads. No tracking. We don't sell your data. Location is optional: search for a place or pick one from the list.
>
> SUBSCRIPTION DETAILS
> AirHappy Pro is available as an auto-renewing subscription: $1.99 per month or $12.99 per year (U.S. prices; Apple shows the price in your currency). Payment is charged to your Apple Account when you confirm the purchase. The subscription renews automatically unless you turn off auto-renew at least 24 hours before the end of the current period. Your account is charged for renewal within 24 hours before the period ends. Manage or cancel any time in Settings > your name > Subscriptions.
>
> Privacy Policy: https://airhappy.app/privacy
> Terms of Use: https://www.apple.com/legal/internet-services/itunes/dev/stdeula/
> Support: https://airhappy.app/support
>
> AirHappy forecasts air quality. It is not medical advice. If you have asthma, heart or lung disease, or are pregnant, follow your doctor's advice and local health alerts.

(2,154)

## URLs

| Field | URL |
| --- | --- |
| Support URL (required) | https://airhappy.app/support |
| Privacy Policy URL (required) | https://airhappy.app/privacy |
| Marketing URL (optional) | https://airhappy.app |
| Terms of Use (EULA) | Apple's standard EULA (linked above) unless Jason wants a custom one. Auto-renewing subscriptions need a Terms of Use link in the description or a custom EULA. |

## Other App Store Connect fields (suggested)

| Field | Suggestion |
| --- | --- |
| Primary category | Weather |
| Secondary category | Health & Fitness |
| Age rating | 4+ |
| Subscription group | AirHappy Pro, with two products: monthly $1.99 and yearly $12.99 |
| Copyright | © 2026 BBCVC LLC |
| Screenshot 1 | Answers the primary question: today's timeline with the best window highlighted, captioned "When is it safe to be outside today?" |

## App Privacy ("nutrition label") draft

Matches `/privacy`. Recheck against the binary that actually ships.

| Data type | Collected? | Linked to user | Tracking | Purpose |
| --- | --- | --- | --- | --- |
| Location: precise (saved place coordinates) | Yes, when places are kept on the server | Yes | No | App functionality |
| Purchases (subscription status) | Yes | Yes | No | App functionality |
| Identifiers: user ID | Yes | Yes | No | App functionality |
| Identifiers: device ID (push token) | Only if alerts are on | Yes | No | App functionality |
| Contact info (name, email) | Only if sign-in ships in the app | Yes | No | App functionality |
| Health, browsing, search history, usage data, diagnostics | No | — | — | — |

If the first build keeps places on the device only, with no account or server sync, most rows become "Not collected". Update the label before submitting.

## Open before submission (not done here: no spend, no publishing)

1. **`support@airhappy.app` has to exist and be monitored.** The Support page, the Privacy page and this listing all use it. It is set in one place: `AIRHAPPY.supportEmail` in `src/components/airhappy-page.tsx`.
2. **airhappy.app must serve this web app.** That means a DNS record at Hover and a Vercel domain. Until then, the Support and Privacy URLs don't load. These pages also work at any host that serves the app (for example `/support` on aether-aqi.vercel.app).
3. **iOS paywall links:** `ios/AetherAQI/Model/Pro.swift` still points Terms and Privacy at `example.com` placeholders. Point them at the URLs above in a follow-up.
4. **Commitments for Jason to confirm** in the policy and support copy:
   - data requests completed within 30 days;
   - support email usually answered within two business days.
5. **Screenshots** for 6.9" and 6.5" iPhones are not made yet.
