# Audit — Air Quality Watchlist before the App Store

Date: 2026-09-29. Scope: the repo as of `main`, plus a read-only check of the live site. No production, DNS, or Vercel settings were changed.

This audit is the input to [IOS-PLAN.md](./IOS-PLAN.md), [LISTING.md](./LISTING.md), and [BACKLOG.md](./BACKLOG.md). The older note [../IOS-APP-STORE.md](../IOS-APP-STORE.md) recommended a remote WebView. That path does not clear App Store Review Guideline 4.2. Use the plan in this folder instead.

## What the app does today

Air Quality Watchlist is an installable PWA. A person saves up to 15 places, sees a live US AQI number and band, expands a card for pollutant values and a 4-day forecast, and opens a map of those places with a coarse regional color wash.

Live hosts (both returned HTTP 200 from Vercel on 2026-09-29):

| Host | Role |
| --- | --- |
| https://aqi.burum.dev | Public hostname named for this reopen |
| https://aether-aqi.vercel.app | Vercel project `aether-aqi`; still the default Open Graph / canonical origin in code |

A sample `GET /api/aqi?lat=43.615&lon=-116.202` on `aqi.burum.dev` returned a current US AQI and `timezone: America/Boise`. The HTML `<title>` is **Air Quality Watchlist**. `og:url` is still `https://aether-aqi.vercel.app/`.

Shipped behavior (v1.6):

| Surface | Behavior |
| --- | --- |
| List (`/`) | Cards for each saved place. Tap expands in place. |
| Forecast | **By hour** area chart and **By day** bar chart. A day is the average of that day’s hourly US AQI, not the EPA daily maximum. Tap a day to see that day’s hours. Labels use a 12-hour clock. |
| Add place | Search (2+ characters) or “Use my current location”. Cap 15. A new card is not auto-expanded. |
| Edit list | Trash button, swipe-left Delete, grip drag (desktop) or long-press drag (touch). Order is the array order. |
| Refresh | Invalidates every `["aqi", …]` query. Each card also refetches on an interval. |
| Map (`/map`) | MapLibre map, numbered pins for saved places only, Locate (pans the camera; does not add a place), bottom sheet, regional wash. |
| Empty states | List and map both explain how to add places. |
| Install | In-app “Add to Home Screen” guide and copy-invite text. This is a PWA install path, not an App Store path. |
| Persistence | `localStorage` key `aether-locations-v1` via Zustand persist. Not synced across devices. |
| Disclaimer | Expanded card only: modeled US AQI via Open-Meteo / CAMS, not a substitute for AirNow. |

Default places until the list is edited: McCall ID, Boise ID, Salt Lake City UT, Los Angeles CA. Each is stored with `alertAt: 100`.

There is no account UI on the home shell. `/login` still exists and says “Sign in to Aether”. Auth code defaults **on** unless `VITE_AUTH_ENABLED=false` (`src/lib/auth/client.ts`). Production env was not inspected (Vercel settings were left alone). Treat “no accounts in production” as unverified until that flag is confirmed.

## Stack

| Layer | Choice |
| --- | --- |
| UI | React 19, Tailwind CSS v4, Recharts, Lucide, a small set of Radix primitives |
| Routing / data | TanStack Start, TanStack Router, TanStack Query |
| Client state | Zustand (`src/lib/locations-store.ts`) |
| Map | MapLibre GL 6, worker copied to `public/maplibre/`, style URL on CARTO’s CDN |
| Server | Vite 8 build, Nitro `vercel` preset only when `command === "build"` (`vite.config.ts`) |
| Auth (unused in the home UI) | Better Auth at `/api/auth/*`, optional Grok broker (Google, X). PGLite in local/preview, Postgres when `DATABASE_URL` is set |
| Database migrate | `npm run build` also runs `scripts/migrate.mjs` |
| PWA | `public/manifest.webmanifest`, apple-touch icons, `public/sw.js` cleanup worker |
| Tests in `package.json` | `typecheck`, `lint`. No unit-test script. Playwright is a devDependency; browser scripts live under `scripts/`. |

The production app is a server-rendered TanStack Start app with same-origin API routes. It is not a static `dist/` folder. That matters for any wrapper: Capacitor cannot ship the Nitro server inside an iOS binary.

Unused or hidden relative to the product people actually see:

- `src/routes/login.tsx` and the Better Auth stack
- `src/lib/multiplayer/` (product docs mark social as out of scope)
- `alertAt` is written and never edited (`updateLocation` has no UI caller)
- “Created with Grok” banner renders only if `VITE_SHOW_BUILT_WITH_GROK` is true (default off)

## Data sources and APIs

No third-party API key is in the repo. The browser calls this origin; the server calls upstream.

```text
iPhone / browser
  ├─ GET /api/aqi?lat&lon          → air-quality-api.open-meteo.com/v1/air-quality
  ├─ GET /api/geocode?name         → geocoding-api.open-meteo.com/v1/search
  ├─ GET /api/aqi-grid?west&…      → same air-quality API, chunks of 40 locations
  ├─ BigDataCloud reverse geocode  → browser calls api.bigdatacloud.net directly
  └─ Map tiles / style             → basemaps.cartocdn.com (no key in the client)
```

Watchlist names and coordinates stay in `localStorage` until a fetch sends coordinates upstream.

### Open-Meteo Air Quality and Geocoding

| | |
| --- | --- |
| Used for | Current US AQI, PM2.5, PM10, ozone, CO, NO₂, SO₂, hourly US AQI / PM2.5 / ozone for 4 days (`src/routes/api/aqi.ts`). Place search, 8 results (`src/routes/api/geocode.ts`). Map lattice, current `us_aqi` only (`src/routes/api/aqi-grid.ts`). |
| Key today | None. Free host `air-quality-api.open-meteo.com` and `geocoding-api.open-meteo.com`. |
| Commercial key | Paid plans use `customer-api.open-meteo.com` and an `apikey` query parameter. Same parameters otherwise. |
| Air-quality model | Open-Meteo documents CAMS European (~11 km) and CAMS global (~45 km, 3-hourly) forecasts. US cities use the global domain. This is not AirNow monitor data. |
| Attribution | Data is CC BY 4.0. Credit Open-Meteo, link the licence, and note the modification (US AQI derived from the forecast). Copernicus CAMS terms also expect a “Copernicus Atmosphere Monitoring Service” credit and a non-endorsement line. The expanded card mentions Open-Meteo / CAMS. The map and store listing do not yet. |
| Liability | Open-Meteo disclaims accuracy and uptime on the free tier. |

Terms checked 2026-09-29 at https://open-meteo.com/en/terms and https://open-meteo.com/en/pricing.

Free / open-access limits (non-commercial only):

| Window | Cap |
| --- | --- |
| Minute | 600 calls |
| Hour | 5,000 calls |
| Day | 10,000 calls |
| Month | 300,000 calls |

Open-Meteo’s non-commercial examples are private or non-profit sites and apps **without** subscriptions or ads, personal home automation, public research, and education. Commercial examples include integrating the service into a **commercial product**, apps with subscriptions or ads, and promotional use. A free app with no ads can still be a commercial product when a company ships it. BBCVC LLC’s App Store app falls on the commercial side of those examples. Do not treat the free tier as cleared for the store binary.

Paid plans (commercial use allowed), from Open-Meteo’s plan announcement and the 2026 pricing summary. The pricing page confirms the licence and the call budgets; confirm the dollar amount on Stripe before subscribing:

| Plan | Commercial | Monthly budget | Published price |
| --- | --- | --- | --- |
| Standard | Yes | 1,000,000 | $29 / month |
| Professional | Yes | 5,000,000 | $99 / month |
| Enterprise | Yes | 50,000,000+ | Contact |

Standard includes the Air Quality and Geocoding APIs. It excludes historical, climate, and ensemble APIs (not used here). Paid traffic goes to reserved servers with a 99.9% uptime target. Free tier has no uptime promise. Open-Meteo says monthly caps are not hard-cut yet, with email alerts at 80 / 90 / 100 percent.

Call weight is not always one HTTP request. Their rule of thumb is `locations × (days / 14) × (variables / 10)`, with a floor of 1, and the location count multiplies. This app’s single-place forecast (about 4 days, under 10 variables) is about **1 call per place**. A map grid of up to 140 current-only points can count as **on the order of one call per point** (chunks of 40 still carry the location multiplier).

Rough load from the client as written:

- Each visible place refetches every 15 minutes (`refetchInterval`) and again on window focus (`refetchOnWindowFocus: true` in `src/routes/__root.tsx`). Fifteen places left open for 8 hours is on the order of a few hundred calls per device per day, before the map.
- One regional paint can be ~140 location-weights, and panning merges more cells.

A handful of heavy map users can spend the free 10,000/day budget. One million calls/month on Standard is enough for an early App Store launch if the grid stays coarse and the key is not left open to the whole internet.

Server behavior worth knowing before a paid key exists:

- `/api/aqi` checks that lat/lon are finite. It does not clamp to ±90 / ±180.
- Responses are `Cache-Control: public, max-age=60` (grid: 120s, geocode: 300s). React Query keeps results stale for 5 minutes.
- There is no app-level rate limit, auth, or API key on the proxy. Anyone who can reach the site can spend the upstream quota. A commercial key must stay in server env, never in the iOS binary, and the proxy needs a gate before that key is added. That is a production change; it is not part of this branch.

Privacy (Open-Meteo’s own notice): free-tier logs may include coordinates and IP, are not linked to an identity, are not sold, and are deleted after 90 days. Paid usage logs are tied to the subscription and then aggregated.

### BigDataCloud reverse geocode

| | |
| --- | --- |
| Call site | `reverseGeocode()` in `src/lib/open-meteo.ts`, only from “Use my current location” |
| URL | `https://api.bigdatacloud.net/data/reverse-geocode-client` with lat, lon, `localityLanguage=en` |
| Key | None |
| Why it exists | Open-Meteo search has no reverse endpoint |

Checked 2026-09-29 against BigDataCloud’s docs: the client-side reverse API is free for commercial and non-commercial apps, with no hard monthly cap, **if** the call is made from the device using that device’s current location (HTML Geolocation or a native location API). Server-side or batched calls to this endpoint are out of policy and can return HTTP 402. Do not move this call onto Vercel.

They describe the exchange as: the device’s coordinates and IP are paired anonymously to improve IP-geolocation quality. That is a third-party use of precise location and must be in the privacy policy for the **website**. The iOS app should use `CLGeocoder` instead and not call BigDataCloud. See [IOS-PLAN.md](./IOS-PLAN.md).

### CARTO Dark Matter basemap

| | |
| --- | --- |
| Call site | `MAP_STYLE` in `src/components/watchlist-map.tsx` |
| URL | `https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json` |
| Key | None. Comment in code says “no API key”. |

CARTO Basemaps Terms (last updated 26 August 2026, https://carto.com/legal/basemap-terms/):

- The customer must use the basemap with **their own** API key (section 8).
- Unauthenticated tile responses may be watermarked (section 3.d).
- Free Basemap Services, with a key, allow 5,000,000 tile requests per calendar month (section 12.c). CARTO’s key-request page, read the same day, also describes a commercial free allowance (about 1M/month on that page) and paid tiers above it. The PWA is on neither allowance today because it sends no key.
- Displaying tiles in your own app, fetched by the client from CARTO, is allowed. Proxying or server-caching the tiles is not (section 9.c). This app loads tiles in the browser, which matches the allowed shape, but without a key.
- Cache on a device for at most 30 days.
- Attribution must stay visible: © OpenStreetMap contributors, © CARTO (https://carto.com/attributions). MapLibre’s compact attribution control is on. Confirm it is still readable on a phone; the CSS shrinks it to 10px.
- OSM data is ODbL. Not for turn-by-turn navigation (not a risk here).

For the iOS app, MapKit avoids this dependency. If a later iOS version keeps MapLibre for the regional wash, request a CARTO key restricted to bundle id `llc.bbcvc.aqi` and keep attribution. Do not proxy tiles through Vercel.

### Not used

AirNow, IQAir, WeatherKit, and Google Maps are not called. Do not name them as data sources in the store listing except to say the index is **not** an AirNow regulatory feed.

## Location handling

| Action | API | Leaves the device? |
| --- | --- | --- |
| Use my current location | `navigator.geolocation.getCurrentPosition`, `enableHighAccuracy: false`, 12s timeout | Yes. Coordinates go to BigDataCloud (name) and then to `/api/aqi` → Open-Meteo. The place is stored locally. |
| Locate on the map | Same Geolocation API, `enableHighAccuracy: true` | The fix is used to move the camera. It is not saved. Subsequent map pans can send the **viewport** bounds to `/api/aqi-grid`, which is not the same as GPS, but it is still a location query. |
| Search | Typed text | The query string goes to `/api/geocode` → Open-Meteo. Results are not stored server-side by this app. |
| Saved places | — | Lat/lon live in `localStorage` and are sent whenever AQI is fetched. |

There is no background location, no “always” permission, and no location history on the server that this repo writes. Permission copy is the browser’s generic prompt. Denied or missing geolocation surfaces as inline text (“Location permission denied or unavailable.” / “Could not get location”).

Duplicate detection treats two places within 0.02° (~2 km) as the same, so a neighborhood and a nearby monitor can be rejected with “already tracked”.

## Offline and PWA behavior

The manifest (`public/manifest.webmanifest`) is `standalone`, portrait-primary, theme `#0c0f12`, short name **Air Quality**. Icons: 192, 512, maskable 512, apple-touch 180 / 167 / 152.

`public/sw.js` is a one-shot cleanup worker. On activate it deletes caches, unregisters itself, and reloads clients. `src/routes/__root.tsx` registers that worker and then unregisters service workers again after 2.5s. Fetch is not intercepted. **There is no offline app shell and no offline AQI cache.** React Query memory cache dies with the tab. A failed reading shows “Failed” on the card and “Some readings failed — tap Refresh” in the header. Last-good numbers are not retained across a reload.

iOS Home Screen install is the current “app”: Safari → Share → Add to Home Screen. The install guide (`src/components/install-guide.tsx`) hard-codes `https://aether-aqi.vercel.app` in the share blurb. Web Push / `Notification` is not a substitute for App Store notifications: the only notification code runs in the open tab, and only if `Notification.permission` is already `"granted"`. Nothing in the UI calls `Notification.requestPermission()`.

Other PWA details that are in good shape for the website and irrelevant inside a native shell: `viewport-fit=cover`, safe-area padding without a fake 47px status-bar floor, 16px inputs to avoid iOS focus zoom, critical CSS inlined so a stale worker cannot leave an unstyled shell.

## Accessibility

What is in place:

- `html lang="en"`.
- Visible text for the AQI band, not color alone (`getAqiMeta().label`).
- Trash buttons have `aria-label`. The add sheet is `role="dialog"` / `aria-modal` and closes on Escape.
- Forecast switch is a `tablist`. Map pins and Locate have names. Bottom nav uses `aria-current="page"`.
- `:focus-visible` outline uses `--color-ring` (`#9aa3ad`).
- Body text `--color-fg` on `--color-bg` is strong. Muted `#8b949e` on `#0c0f12` is roughly 6:1.

Gaps to fix in the native app (and worth fixing on the web before calling the PWA done):

| Issue | Where |
| --- | --- |
| Interactive controls nested inside `role="button"` (trash, and the card itself). Invalid for VoiceOver and keyboard. | `LocationCard` in `src/components/aqi-components.tsx` |
| Reorder grip is a `<span aria-label>` with no tabindex and no keyboard alternative. | Same card |
| Forecast tabs do not implement arrow-key roving tabindex or `aria-controls`. | Expanded card |
| Charts and sparklines are visual only (`Sparkline` is `aria-hidden`). No data table or summary. | Recharts area / bar |
| Add-sheet errors are not in an `aria-live` region. Focus is not trapped in the dialog. | `AddLocationModal` |
| No “reduce motion” handling for drag, chart, or map animations. | Gestures, Recharts, MapLibre |
| `--color-subtle` `#5c6570` on `#0c0f12` is about 3.3:1. Coordinates, chart captions, and the map legend use it at 10–12px. | `src/styles.css` |
| Hazardous text color `#7f1d1d` on `#14191f` is about 1.8:1. The big number and the word “Hazardous” use this token. | `.aqi-hazardous` |
| Drag-and-swipe have no spoken alternative beyond the trash button (trash does work). | Cards |

## Performance

Fine for 15 cards on a recent phone. The map is the cost.

- Regional raster: `renderDataUrl` in `src/lib/aqi-field-model.ts` evaluates inverse-distance weighting for every pixel on the main thread, up to 560×420, then a box blur, then a PNG data URL. Paint is deferred until the camera is idle (a previous freeze was fixed in v1.6). It can still hitch on a low-end phone when the user stops panning.
- Lattice is 2°. The wash is a smooth picture of a coarse sample, not a street-level forecast. Pins override nearby cells so the number on the pin matches the card.
- Map grid fetches are the main API-cost driver (see above).
- List and map each run `useQueries` for every place. Opening the map does not reuse an in-flight list subscription across routes; the query cache does dedupe by key while both are mounted, and the cache survives client-side navigation.
- `networkMode: "always"` so a backgrounded tab does not sit on “paused” forever. Combined with a 15-minute interval, an installed PWA left open keeps polling.
- MapLibre’s worker is served from `public/maplibre/` so the hashed Vite worker URL cannot break the shared chunk. Those files are large and ship with every deploy.

## Bugs and rough edges before launch

Ordered by how much they matter for a store submission. Effort lives in [BACKLOG.md](./BACKLOG.md).

1. **Threshold alerts are not a feature yet.** `alertAt` defaults to 100 and is never shown or edited. The notification effect only runs when permission is already granted, dedupes with `sessionStorage`, and only while this page is open. On an iPhone PWA that means people do not get alerts.
2. **Commercial licensing of Open-Meteo is not in place**, and the proxy would expose a future key to anonymous traffic.
3. **The map loads CARTO with no API key**, against current basemap terms.
4. **“Main pollutant” prefers PM2.5 whenever it is above zero** (`primaryPollutant` in `src/lib/open-meteo.ts`). It is not the pollutant that set the US AQI.
5. **Daily bars are an average of hourly US AQI.** A smoky afternoon can look milder than the worst hour. The label does not say “average”.
6. **CO and SO₂ are fetched and dropped.** The card shows PM2.5, PM10, ozone, and NO₂ only.
7. **No offline last reading.** Airplane mode is an empty or failed list.
8. **`/login` still brands “Aether”** and can start Google/X sign-in if auth env is on. The iOS app must not ship this.
9. **Canonical and share URLs ignore `aqi.burum.dev`** unless `VITE_PUBLIC_HOSTNAME` is set at build time. The invite blurb hard-codes `aether-aqi.vercel.app`.
10. **Hazardous (and subtle) text contrast** fails ordinary WCAG body-text contrast.
11. **Nested card buttons and a non-keyboard reorder control.**
12. **Service worker still registers on every visit** in order to tear itself down. That is a recovery hatch from an older cache bug, not an asset. It can cause an extra reload.
13. **Add-sheet duplicate radius (~2 km)** rejects legitimate nearby places with a vague error.
14. **Install guide inside a future WebView** would tell App Store users to add the site to the Home Screen. The native app should not include it.
15. **Auth, multiplayer, and Grok-broker code** are in the production bundle even though the home screen hides them. They are harmless only while the env flags stay off. Confirm that before writing “we don’t collect accounts” on the store form.

Nothing in this pass was a production outage. The list, forecast, and map are a coherent product. They are not yet an App Store app, and the data licences are the gate in front of the binary.
