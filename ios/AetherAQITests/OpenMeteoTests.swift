import Foundation
import Testing
@testable import AetherAQI

/// 2026-11-06 06:00Z and the hours after it, in Open-Meteo's `timeformat=unixtime` shape.
private let start = 1_793_944_800.0
private func body(hours: Int = 72, currentAqi: String = "31") -> Data {
    let times = (0..<hours).map { String(Int(start) + $0 * 3600) }.joined(separator: ",")
    let aqi = (0..<hours).map { $0 == 5 ? "null" : String(20 + $0) }.joined(separator: ",")
    let pm = (0..<hours).map { String(20 + $0) }.joined(separator: ",")
    let ozone = (0..<hours).map { $0 < 10 ? "10" : String(30 + $0) }.joined(separator: ",")
    return Data("""
    {"latitude":44.67,"longitude":-116.12,"current":{"time":\(Int(start) + 2 * 3600 + 900),"interval":900,
    "us_aqi":\(currentAqi),"us_aqi_pm2_5":31,"us_aqi_ozone":12},
    "hourly":{"time":[\(times)],"us_aqi":[\(aqi)],"us_aqi_pm2_5":[\(pm)],"us_aqi_ozone":[\(ozone)]}}
    """.utf8)
}

private func provider(_ data: Data, now: Date) -> OpenMeteoAirProvider {
    OpenMeteoAirProvider(fetch: { _ in data }, now: { now })
}

@Suite("Live air from Open-Meteo")
struct OpenMeteoTests {
    let place = SampleAirProvider.tamarack
    /// 08:20Z, so the current hour is 08:00Z (lead 2 of the response).
    let now = Date(timeIntervalSince1970: start + 2 * 3600 + 1200)

    @Test("Asks for the place's pin, keyless, in UTC seconds")
    func url() throws {
        let url = OpenMeteoAirProvider.url(latitude: 44.671, longitude: -116.117).absoluteString
        #expect(url.hasPrefix("https://air-quality-api.open-meteo.com/v1/air-quality?"))
        #expect(url.contains("latitude=44.671") && url.contains("longitude=-116.117"))
        #expect(url.contains("timeformat=unixtime") && url.contains("timezone=GMT"))
        #expect(!url.lowercased().contains("key"))
    }

    @Test("The home number is the current US AQI, with the main pollutant and the credit, and no AirNow reading")
    func snapshot() async throws {
        let snap = try #require(try await provider(body(), now: now).homeSnapshot(for: place))
        #expect(snap.now.aqi == 31)
        #expect(snap.now.pollutant == "PM2.5")
        #expect(snap.now.issuedAt == Date(timeIntervalSince1970: start + 2 * 3600))
        #expect(snap.official == nil)
        #expect(snap.credit == OpenMeteoAirProvider.credit)
        #expect(snap.place == place)
    }

    @Test("The timeline runs from the current hour through 48 hours, gaps stay empty")
    func timeline() async throws {
        let rows = try await provider(body(), now: now).hourlyForecast(for: place)
        let timeline = try #require(ForecastTimeline(rows: rows))
        #expect(timeline.issuedAt == Date(timeIntervalSince1970: start + 2 * 3600))
        #expect(timeline.slots[0].aqi == 22)
        #expect(timeline.missingLeads == [3])          // hour 5 of the response had no value
        #expect(timeline.slots[48].aqi == 70)
        #expect(timeline.slots[48].pollutant == "Ozone") // ozone 80 beats PM2.5 70 there
    }

    @Test("No current value falls back to the current hour; no value at all is the empty state")
    func fallbacks() async throws {
        let snap = try #require(try await provider(body(currentAqi: "null"), now: now).homeSnapshot(for: place))
        #expect(snap.now.aqi == 22)
        let late = Date(timeIntervalSince1970: start + 200 * 3600)
        #expect(try await provider(body(currentAqi: "null"), now: late).homeSnapshot(for: place) == nil)
    }

    @Test("A place with no pin can't be fetched")
    func noPin() async {
        let bare = Place(id: "p", name: "Nowhere", region: "Idaho", timeZone: place.timeZone)
        await #expect(throws: AirDataError.unavailable) { try await provider(body(), now: now).homeSnapshot(for: bare) }
    }

    @Test("Saved places carry their pin to the home screen")
    @MainActor
    func savedPin() async throws {
        let defaults = try #require(UserDefaults(suiteName: "OpenMeteoTests"))
        defaults.removePersistentDomain(forName: "OpenMeteoTests")
        let model = PlacesModel(provider: LocalPlacesProvider(defaults: defaults), candidates: [], isPro: false, defaults: defaults)
        await model.load()
        #expect(model.activePlace?.latitude == 44.671)
        #expect(model.activePlace?.longitude == -116.117)
    }
}
