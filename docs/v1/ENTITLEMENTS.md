# v1 phase 3 — Pro entitlement

Server-side gate for Project Air phase 3. One entitlement row per user. No row means Free. This branch does not change `ios/`, `design/`, or the App Store capability set. There is no App Store Connect key, no environment variable, and no call to Apple.

## Store

`migrations/0004_v1_entitlement.sql`. The purchased row is always tier `pro`. Free is the absence of a row.

| Column | Meaning |
| --- | --- |
| `user_id` | One row per user. |
| `tier` | `pro`. The purchase, not the live gate. |
| `product` | `monthly` ($1.99) or `yearly` ($12.99). Prices live in `PRO_PRICE_USD` in `src/lib/v1/entitlements.ts`. |
| `source` | `storekit` only. |
| `expires_at` | End of the signed transaction. |
| `state` | `active`, `grace`, `expired`, or `revoked`. |

`effectiveEntitlement` is what the app branches on. `grace` stays Pro after `expires_at`. `active` stays Pro only while `expires_at` is still ahead; a stale `active` row is reported as `expired` and is not rewritten. `revoked` is never Pro, even when `expires_at` is in the future. `GET` returns `tier: "free"` and `pro: false` for every case that is not currently Pro, and keeps `product`, `priceUsd`, and `state` when a row exists.

`saved_place_user_is_pro` is that same rule in SQL. The saved-place trigger checks the cap of 5 first, then refuses a second place unless the user is Pro. Existing rows are left in place. `addSavedPlace` maps the trigger's Pro refusal to `not_entitled` and the cap to `place_cap`.

## What Free keeps

For the first saved place (lowest `position`, then `created_at`):

| Read | Route |
| --- | --- |
| Current air | `GET /api/v1/places/:id/current` |
| 48-hour timeline | `GET /api/v1/places/:id/timeline` |
| Best window | `GET /api/v1/places/:id/best-window` |
| Outlook | `GET /api/v1/places/:id/outlook` |

Current air is the corrected hour that contains `asOf`, plus the latest official AirNow reading at or before `asOf`. Either side is null when nothing is stored. The timeline is the corrected hours in `[asOf, asOf + 48 hours]`, including that exact end (`DAY12_MS`). Deleting the first place opens the next one. Places past that one stay stored.

Smoke, inversion, and ozone alerts are Pro on every place, including the first.

## What Pro adds

Alerts, and saved places 2 through 5. The sixth place is still `place_cap` (409), for Pro and for a downgraded account that already holds five.

A downgrade (expired or revoked) does not delete places or forecasts. `GET /api/v1/places` still lists them and sets `openPlaceIds` to the one Free place. Reads of any later place, including alerts, return the not-entitled shape with `feature: "saved_places"`. `GET /api/v1/forecasts` leaves the later places out. A forecast or official write aimed at a closed place is refused and writes nothing. `POST /api/v1/push/deliver` resolves the forecast's place and runs that same place gate before it sends or writes `push_delivery`. A locked place is 403 `not_entitled` with `feature: "saved_places"` and no delivery row. The first place still delivers.

## Not entitled

Status 403. Never 500. `NotEntitledError` in `src/lib/v1/errors.ts`.

```json
{ "error": "not_entitled", "message": "...", "feature": "alerts", "tier": "free" }
```

`feature` is `alerts` or `saved_places`. A missing place is still `place_not_found` (404). A bad `asOf` or `timeZone` is still 400, checked before the gate. A user with no row is Free, and that read is 200.

## StoreKit

`StoreKitVerifier` in `src/lib/v1/storekit.ts` accepts one signed-transaction string. `FixtureStoreKitVerifier` is the test double: three segments, algorithm `fixture`, signature the word `fixture`. It decides `active`, `grace`, `expired`, or `revoked` from `expiresAt`, `inGracePeriod`, and `revokedAt`. Revocation wins. `unavailableStoreKitVerifier` refuses every payload, including the fixture form.

`applySignedTransaction` stores the verified result. The latest transaction replaces the same row. Nothing on the request path calls it. `GET /api/v1/entitlement` is the only entitlement route, and it does not take a body. `POST` is 405.

## HTTP

The gate is `handleV1` in `src/lib/v1/http.ts`. The existing `/api/v1/$` route already forwards there.

| Method | Path | Who |
| --- | --- | --- |
| GET | `/api/v1/entitlement` | The signed-in user. No row is Free. |
| GET | `/api/v1/places/:id/current` | Free for the first place. |
| GET | `/api/v1/places/:id/timeline` | Free for the first place. |
| GET | `/api/v1/places/:id/alerts` | Pro. |

Best window, outlook, the forecast list, and push delivery follow the same place gate as current air. Delivery looks up the forecast's place before the test send and the `push_delivery` insert.

## Checks

```bash
npm test
npm run lint
npm run typecheck
```

`npm test` stays on PGLite. It does not need `DATABASE_URL`, and it does not call Apple, NOAA, or AirNow.

Dex reviews this head. Only Clint merges.
