# Aether AQI — native iOS (scaffold)

SwiftUI app mirroring the PWA's core view: current US AQI ring, category + advice, main pollutant, PM2.5/PM10/O₃.

- Project is defined with [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen && cd ios && xcodegen` → open `AetherAQI.xcodeproj`.
- Bundle id `llc.bbcvc.aqi` is a placeholder until BBCVC enrolls in the Apple Developer Program. Local simulator builds need no paid account.
- Data: calls the PWA's `/api/aqi` proxy (Open-Meteo behind it).
- **License flag:** Open-Meteo free API is non-commercial. Commercial plan (~$29/mo) is NOT approved. Dev use only until resolved.
- Location: when-in-use permission; falls back to Boise, ID.

Status: not yet compiled — Xcode install on the Mini is blocked on Apple ID sign-in.
