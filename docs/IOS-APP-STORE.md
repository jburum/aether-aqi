# Publishing to the Apple App Store (free app)

Last updated: 2026-08-05

This app is a **PWA** (React / Vite / Vercel). Apple does **not** accept a pure website URL as an App Store app. You ship a thin **native shell** that loads your web app (and optionally offline assets). Recommended path: **Capacitor**.

---

## Goal

| Item | Decision |
| --- | --- |
| Platform | iOS App Store |
| Price | **Free** |
| Core experience | Same product as [aether-aqi.vercel.app](https://aether-aqi.vercel.app) |
| Approach | Capacitor iOS wrapper + production URL (or bundled build) |

---

## Phase 0 — Prerequisites (1–2 days admin)

1. **Apple Developer Program** — [developer.apple.com](https://developer.apple.com) — **$99/year** (required even for free apps).
2. **Mac** with recent **Xcode** (App Store).
3. **Legal pages** (HTTPS, public):
   - Privacy Policy (required) — what you store (localStorage only today), Open-Meteo, no account
   - Support URL (can be a simple page or email mailto on your site)
4. **App identity**
   - Name (e.g. **Air Quality Watchlist**)
   - Bundle ID (e.g. `com.jasonburum.aqiwatchlist`)
   - SKU (internal string)

---

## Phase 1 — Wrap with Capacitor (1–2 days engineering)

```bash
cd ~/Projects/AQI
npm install @capacitor/core @capacitor/cli @capacitor/ios
npx cap init "Air Quality Watchlist" com.jasonburum.aqiwatchlist
```

**Two load strategies:**

| Strategy | How | Pros | Cons |
| --- | --- | --- | --- |
| **A. Remote URL (recommended first)** | WebView → `https://aether-aqi.vercel.app` | Instant updates via Vercel; no App Store resubmit for most UI fixes | Needs network; Apple may ask about “minimum functionality” |
| **B. Bundled web build** | `npm run build` → copy `dist` / Nitro output into native app | Works offline-ish; feels more “native” to reviewers | Every web change needs a new binary (or hybrid) |

**Recommendation:** Start with **A** for speed; add **B** or hybrid if review pushes back.

```bash
npx cap add ios
# capacitor.config.ts → server.url = 'https://aether-aqi.vercel.app' (for strategy A)
npx cap open ios
```

Useful plugins later:

- `@capacitor/geolocation` — better Locate me / “current location”
- `@capacitor/status-bar` — match dark theme under the notch
- `@capacitor/splash-screen` — branded launch
- `@capacitor/app` — back button / URL open

**iOS project checklist (Xcode):**

- Deployment target iOS 15+ (or current Xcode default)
- Portrait (and landscape if you want)
- App icons 1024×1024 (+ asset catalog; can derive from `public/icon-512.png`)
- Launch screen (simple dark + wordmark)
- ATS: allow HTTPS only (default OK for Vercel)
- Background modes: none required for v1

---

## Phase 2 — App Store Connect (1 day)

1. Create app in [App Store Connect](https://appstoreconnect.apple.com).
2. **Free** price tier.
3. **Privacy Nutrition Labels** — honest answers:
   - Data not collected (if truly no analytics)
   - If you add analytics later, update labels
4. **App Privacy Policy URL** (must load).
5. **Screenshots** (required sizes for iPhone — 6.7" and 6.5" at minimum for modern submissions):
   - List view with AQI cards
   - Expanded forecast
   - Map tab with pins
6. **Description** — clear that AQI is **modeled** (Open-Meteo / CAMS), not EPA AirNow regulatory.
7. **Category** — Weather or Health & Fitness.
8. **Age rating** — typically 4+ if no objectionable content.
9. **Review notes** — “No login. All features work offline for saved places’ last fetch; live AQI needs network. Test locations preloaded.”

---

## Phase 3 — Review risk & mitigations

Apple rejects thin wrappers that are “just a website.” Mitigations:

| Risk | Mitigation |
| --- | --- |
| “Minimum functionality” | Ship **List + Map**, offline-friendly shell, splash, status bar, geolocation permission usage string |
| “Spam / copycat” | Original branding (already debranded from “Aether”); don’t claim IQAir/AirNow |
| WebView-only | Capacitor + native chrome (splash, icons); optional small native settings screen |
| Location permission | `NSLocationWhenInUseUsageDescription`: “Show your position on the air quality map and add nearby places.” |
| Accuracy claims | Disclaimer in app + store description |

**Info.plist usage strings (examples):**

```text
NSLocationWhenInUseUsageDescription = Show your location on the map and add nearby places to your watchlist.
```

---

## Phase 4 — Build, TestFlight, Submit (2–5 days)

1. Archive in Xcode (Release, automatic signing with your team).
2. Upload to App Store Connect.
3. **TestFlight** internal test on your iPhone (critical: safe-area, map tiles, geolocation).
4. Submit for review.
5. Respond to any Guideline 4.2 / metadata feedback.

Typical first-time review: **24–48 hours** (can be longer).

---

## Phase 5 — After approval

- App Store link + QR on your site
- Optional: “Get the app” banner on the PWA (detect iOS Safari)
- Keep **Vercel** as the content host (strategy A) so map/list fixes ship without waiting on Apple
- Plan major native releases when you add notifications (threshold alerts need APNs)

---

## Timeline (realistic)

| Week | Work |
| --- | --- |
| 1 | Developer account, privacy page, Capacitor iOS project, icons/splash |
| 2 | TestFlight, screenshot pass, store listing copy |
| 3 | Submit + review cycle |

**Cost:** $99/year Apple Developer. Basemap tiles free (current MapLibre + Carto style). No IAP for a free app.

---

## What we will *not* do for v1 store

- React Native / Flutter rewrite
- IQAir station network or proprietary APIs
- Claiming regulatory-grade AQI
- Account system (optional later)

---

## Next engineering steps (when you say go)

1. Add Capacitor to this repo (`ios/` directory).
2. `capacitor.config` → production URL + app id.
3. Status bar + splash plugins.
4. Generate 1024 icon set from existing brand.
5. Xcode archive → TestFlight with you as tester.
