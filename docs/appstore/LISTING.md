# App Store listing draft — Air Quality Watchlist

Date: 2026-09-29. Seller: **BBCVC LLC**, after the organization Apple Developer account is enrolled. The binary this copy describes is the native app in [IOS-PLAN.md](./IOS-PLAN.md), not the website in a WebView.

Confirm every URL returns 200 with no login before you paste it into App Store Connect. This repo does not host `bbcvc.llc`.

## Name, subtitle, keywords

App name limit is 30 characters. Subtitle is 30. The keyword field is 100 characters, comma-separated, no spaces. Do not repeat words already in the name or subtitle. Do not use AirNow, IQAir, EPA, or Apple in the keyword field.

| Option | Name | Characters | Note |
| --- | --- | --- | --- |
| **Use this** | Air Quality Watchlist | 21 | Matches the PWA title, the manifest, and the icon. |
| Alternate | AQI Watchlist | 13 | Shorter if the longer name is unavailable on the account. |
| Avoid | BBCVC Air, Aether, Aether AQI | — | Company name belongs in the seller field. “Aether” is leftover branding (`/login`). |

**Subtitle:** `Places, forecasts, alerts` (25)

**Keywords** (95 characters):

```text
aqi,pm2.5,pm10,ozone,smoke,wildfire,forecast,pollution,no2,particulate,haze,dust,alerts,outdoor
```

## Category, price, availability

| Field | Value |
| --- | --- |
| Primary category | Weather |
| Secondary category | Utilities |
| Price | Free |
| Distribution | App Store, all territories you are allowed to sell in. Start with the US if you want a smaller first review; the data is global. |
| Devices | iPhone. Not iPad for v1. |
| Kids category | No |

Do not file the app under Health & Fitness. The advice strings are the usual AQI activity guidance. Putting the app in a medical category invites Guideline 1.4.1 questions you do not need. Do not say the app diagnoses, treats, or replaces a clinician or a regulatory monitor.

## Description

Paste as plain text. The first lines are what people see before “more”.

```text
Air Quality Watchlist tracks the US Air Quality Index for up to 15 places you choose.

See the current index, the band (Good through Hazardous), and a short activity note. Open a place for PM2.5, PM10, ozone, and NO₂, plus an hourly forecast and a daily view. A map shows your places. A home-screen widget shows the latest reading without opening the app.

Set a threshold per place. When a background refresh finds the index at or above that number, the app can send a local notification. Location is optional: search for a city, or add where you are. Everything you save stays on this iPhone. There is no account.

The index is a modeled US AQI from Open-Meteo and the Copernicus Atmosphere Monitoring Service (CAMS). It is not data from regulatory monitors such as AirNow. During wildfire smoke, check a local official source before you make a health decision.

Air Quality Watchlist is a product of BBCVC LLC.
```

**Promotional text** (170 characters, can change without a new binary):

```text
Watch up to 15 places, see the hourly forecast, and get a notification when the US AQI crosses the threshold you set. Modeled CAMS data, stored on your iPhone.
```

**What’s New** (1.0):

```text
First release. Watchlist, hourly and daily forecast, map, home-screen widget, and optional threshold alerts.
```

## Other metadata

| Field | Value |
| --- | --- |
| Support URL | https://bbcvc.llc/support |
| Marketing URL | https://aqi.burum.dev (optional; the site is the PWA, so the description must not imply the App Store app is that page) |
| Privacy Policy URL | https://bbcvc.llc/privacy |
| Copyright | 2026 BBCVC LLC |
| Age rating | 4+ from the answers below |
| Sign-in required | No |
| Content rights | You own the app. Forecast data is used under Open-Meteo’s commercial API terms and CC BY 4.0. Map tiles in v1 are Apple MapKit, not a scraped basemap. |

Subtitle and description must keep the modeled-data sentence. Reviewers and users both need it.

## Age rating answers

Apple’s form changes. Re-read the live questionnaire when you submit. For the app in the plan (no web view, no accounts, no ads, no shared posts), answer:

| Question | Answer |
| --- | --- |
| Cartoon or fantasy violence | None |
| Realistic violence | None |
| Prolonged graphic or sadistic realistic violence | None |
| Profanity or crude humor | None |
| Mature or suggestive themes | None |
| Horror or fear themes | None |
| Medical or treatment information | None |
| Alcohol, tobacco, or drug use or references | None |
| Sexual content or nudity | None |
| Graphic sexual content and nudity | None |
| Gambling | None |
| Contests | None |
| Unrestricted web access | No |
| User-generated content that is shared with other users | No |
| Messaging and chat | No |
| Advertising | No |

Expected result: **4+**.

Medical / treatment is None because the app shows published AQI activity guidance and tells people it is not a regulatory or clinical source. If a future build adds dosage, diagnosis, or “you have this condition” copy, stop and redo this rating.

Made for Kids: **No.** A 4+ rating is not the Kids category. Do not opt in.

## App Privacy nutrition label

Answers below are for the **recommended iOS app**, not for every code path in the website.

What the binary does:

- Sends latitude and longitude of saved places, and of a one-shot “where I am” fix, to `aqi.burum.dev`, which forwards them to Open-Meteo to compute AQI.
- Uses Apple’s geocoder and MapKit on device / Apple’s services. Does not call BigDataCloud. Does not load CARTO.
- Stores the watchlist, thresholds, and the last readings in an App Group on the device.
- Does not create an account, does not use IDFA, does not use a tracking SDK, does not link data to a name or email.
- Open-Meteo’s own policy (checked 2026-09-29) says API logs can contain coordinates and IP, are kept up to 90 days, and are not tied to a person on the free tier. A paid key ties usage to the BBCVC subscription, then drops individual logs after 90 days.

Apple’s definition of “collected” includes data that leaves the device and can be retained by you **or a partner** longer than it takes to answer the request. Because Open-Meteo keeps logs, declare precise location even though BBCVC does not build a location database.

| Data type | Collected? | Linked to identity? | Used for tracking? | Purpose |
| --- | --- | --- | --- | --- |
| Precise Location | Yes | No | No | App Functionality |
| Coarse Location | Yes | No | No | App Functionality (city label from the geocoder, and the same coordinates rounded by the forecast API) |
| Search History | No | — | — | The city query is sent to answer that search and is not stored by BBCVC. Do not declare it unless you start logging queries. |
| Name, email, phone, physical address | No | — | — | No account |
| User ID / Device ID | No | — | — | No account, no analytics ID. A later push token **is** a device identifier; update this row before you ship push. |
| Product interaction, crash, performance | No | — | — | No analytics SDK in the plan. If you turn on Apple’s crash reports only, follow the form’s current “diagnostics” question; do not add a third-party crash tool without updating the label. |
| Purchases | No | — | — | Free, no IAP |

Tracking: **No.** Do not show the App Tracking Transparency prompt.

Privacy Nutrition Label contact: the same privacy policy URL.

### If you ship the website’s behavior inside the app instead

Do not. For the record, the PWA also sends the current fix to BigDataCloud and loads CARTO tiles (IP and request data to CARTO). Those partners would have to be covered by the label and the policy. The native plan avoids both.

### If you add remote push later

Declare Identifiers (device token) for App Functionality, still not used for tracking. If the server stores the token **with** the watchlist, say whether that record is linked to identity. A token alone is not a name. Say so accurately. Update the policy before the build that uploads places.

## Support URL plan

App Store Connect requires an HTTP(S) support URL. A `mailto:` link is not enough.

| URL | What it is |
| --- | --- |
| https://bbcvc.llc/support | **Support URL.** Static page on the company site. Not the PWA. |
| https://bbcvc.llc/privacy | **Privacy Policy URL.** The draft below. |
| mailto:support@bbcvc.llc | Shown on the support page. Create the mailbox before submission and watch it through review. |
| https://aqi.burum.dev | Optional marketing URL only. |

Support page outline (short, no login, works on a phone):

1. What the app does, in two sentences, including “modeled US AQI, not AirNow”.
2. How to add a place, turn on alerts, and add the widget (widget gallery → Air Quality Watchlist).
3. “Alerts did not fire”: iOS decides when background refresh runs; the app does not use continuous GPS; check that notifications are allowed and a threshold is set.
4. How to delete on-device data: delete a place, or delete the app (the App Group store goes with it). There is no server account to erase.
5. Contact: support@bbcvc.llc. Ask for the iOS version from Settings → About if they write in.
6. Link to the privacy policy.

Host these pages on `bbcvc.llc` (any static host the company controls). Do not point the support URL at a Vercel preview or at `/login`.

## Privacy policy draft

Publish at `https://bbcvc.llc/privacy`. Replace the bracketed address before you publish. This draft covers the iOS app and, in a separate section, the existing website, because they do not collect the same things.

---

**Privacy policy**

**BBCVC LLC**
Last updated: 29 September 2026

This policy describes how BBCVC LLC (“BBCVC”, “we”) handles information when you use the Air Quality Watchlist iOS app and the Air Quality Watchlist website at https://aqi.burum.dev (also served as https://aether-aqi.vercel.app).

Contact: privacy@bbcvc.llc or support@bbcvc.llc.
Postal address: [BBCVC LLC registered mailing address].

We do not sell personal information. We do not show ads. We do not use advertising identifiers. The iOS app does not require an account.

### The iOS app

**Information that stays on your iPhone**

The app stores the places you save (name, latitude, longitude, alert threshold), the order of that list, and the latest air-quality reading for each place. That store is on the device, shared with the home-screen widget through an Apple App Group, so the widget can show the same list. We do not receive a copy of that list on our servers as an account record.

Deleting a place removes it from the device. Deleting the app removes the store.

**Location**

If you allow location access, the app reads your position while you are using it, to center the map or to save the place you are in. The system prompt is “when in use”. The app does not request always-on location and does not follow you in the background.

The city name for that fix is produced by Apple’s geocoder. Saved coordinates, and coordinates you type a search around, are sent to our website so we can ask our forecast provider for an air-quality result. Background refresh sends the coordinates of places you already saved, for the same purpose. It does not turn on GPS by itself.

You can deny location and still search for cities by name.

**Notifications**

If you set a threshold and allow notifications, the app schedules a local notification on the device when a refresh sees an index at or above that threshold. v1 does not upload a push token. If we add server push later, we will update this policy and the App Store privacy label first.

**What we and our providers receive**

Requests for air quality and place search go to https://aqi.burum.dev, hosted for us on Vercel. The request includes the coordinates or the search text, plus ordinary connection data (IP address, time, user agent). Our host may keep short-lived operational logs.

We request the forecast from Open-Meteo (OpenMeteo GmbH, Switzerland) under a commercial API subscription. Open-Meteo’s privacy notice says API logs can include IP address and request URLs (which contain coordinates), are used to run and protect the service, and individual logs are deleted after 90 days. Their terms and privacy notice are at https://open-meteo.com/en/terms.

The forecast is derived from Copernicus Atmosphere Monitoring Service data and is licensed CC BY 4.0. We are not a government air-quality agency.

Map tiles in the iOS app are provided by Apple as part of MapKit. Apple’s privacy policy applies to that processing.

We do not send your position to BigDataCloud from the iOS app.

**Children**

The app is a general-audience weather utility rated 4+. We do not knowingly collect personal information from children. The app has no account signup.

### The website

The website is a progressive web app. It is separate from the App Store binary.

- Places you save are stored in your browser’s local storage on that device. We do not sync them to an account in the current website.
- Air-quality and search requests go to the same `/api/aqi` and `/api/geocode` paths, and then to Open-Meteo, as above. The map can also request a grid of coordinates for the area you are viewing (`/api/aqi-grid`).
- If you choose “Use my current location”, the page sends that fix from your browser to BigDataCloud’s client-side reverse-geocoding service to suggest a city name. BigDataCloud states that this endpoint is called from the device and that coordinates and IP address may be used to improve IP-geolocation quality. Their documentation is at https://www.bigdatacloud.com/. You can skip that call by searching for a city instead.
- The map loads basemap tiles from CARTO (CartoDB Inc.). CARTO receives connection data needed to serve the tiles. Their basemap terms are at https://carto.com/legal/basemap-terms/.
- The site does not include a third-party analytics tag in the current source. Hosting logs may still exist at Vercel.
- A sign-in page exists in the codebase and is not part of the home screen. If it is enabled in a given deployment, signing in with Google or X would create an account (name, email, and a session cookie) through our authentication provider. Do not use that page. We intend to keep accounts off for this product. If we ever turn them on, we will update this policy first.

### Why we use this information

We use location and place queries to show an air-quality forecast, to name a place, and (on iOS, if you opt in) to decide whether to notify you. We use logs to keep the service up and to stop abuse. We do not use this information to advertise to you or to build a profile for sale.

### How long

On the iPhone, until you delete the place or the app. On our side, we do not keep a watchlist database for the iOS app. Host and Open-Meteo logs follow those providers’ retention (Open-Meteo: up to 90 days for individual API logs, as published by them).

### Sharing

We share coordinates and search text with Open-Meteo so they can answer the forecast request, and we rely on Vercel to host that request. The website additionally uses BigDataCloud and CARTO as described above. We may disclose information if the law requires it. We do not sell it.

### Your choices

- Deny location or notifications in iOS Settings. The watchlist still works.
- Remove places in the app.
- Delete the app.
- Email privacy@bbcvc.llc for a question about this policy. If you are in a place that gives you access, correction, or deletion rights over personal information a service provider holds, write to us and we will pass the request to the provider where we can.

### International

We are based in the United States. Our host and Open-Meteo process requests in the United States and Europe. If you use the app from another country, you understand that your request is processed in those places.

### Not medical or regulatory advice

Air-quality values in the app and on the website are modeled. They are not a government monitor reading and they are not medical advice.

### Changes

We will post changes on this page and change the date at the top. If a change makes us collect new categories of data in the iOS app, we will also update the App Store privacy label.

---

## Review notes

Copy into App Store Connect → App Review Information. Also in [IOS-PLAN.md](./IOS-PLAN.md).

```text
Air Quality Watchlist is a native SwiftUI app from BBCVC LLC. It is not a WebView of our website. Saved places, thresholds, and the last readings are stored on device in an App Group. The app loads modeled US AQI from our API (Open-Meteo / CAMS, not AirNow). Test without an account. Location and notifications are optional: search still works if location is denied, and the list still works if notifications are denied. The home-screen widget reads the same on-device list. A background refresh updates readings and files a local notification only after the user sets a threshold. Sample places are preloaded. Privacy policy: https://bbcvc.llc/privacy. Support: https://bbcvc.llc/support.
```

Sign-in on the review form: leave the demo account blank.
