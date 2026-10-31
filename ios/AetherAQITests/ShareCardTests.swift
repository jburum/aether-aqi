import Foundation
import ImageIO
import Testing
@testable import AetherAQI

private let boise = SampleAirProvider.boise
private let official = OfficialReading(
    aqi: 48, observedAt: Date(timeIntervalSince1970: 1_793_456_400), attribution: OfficialReading.airNowAttribution
)

/// Date formats put a narrow no-break space before AM/PM; compare with plain spaces.
private func plain(_ text: String) -> String {
    text.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
}

private func rows(_ fixture: String) throws -> [AlertRowDisplay] {
    let response = try StoreJSON.decoder().decode(AlertsResponse.self, from: Fixture.data(named: fixture))
    return AlertsDisplay(response, fallbackZone: boise.timeZone).rows
}

@Suite("Alert share card content")
struct ShareCardContentTests {
    @Test("Smoke, active: place, kind, status, our corrected peak and its band, the window")
    func smoke() throws {
        let row = try #require(try rows("boise-alerts-smoke-active").first)
        let card = AlertShareCard(row: row, place: boise, official: nil)
        #expect(card.placeName == "Boise")
        #expect(card.title == "Smoke")
        #expect(card.severityText == "High")
        #expect(card.statusText == "Now")
        #expect(plain(card.span) == "7 AM to 2 PM")
        #expect(card.correctedAqi == 168)
        #expect(card.level == .unhealthy)
        #expect(!card.lowConfidence)
        #expect(card.official == nil)
        #expect(card.summary.contains(AlertShareCard.forecastNote))
    }

    @Test("Inversion, upcoming: the peak from the mixing-height reason")
    func inversion() throws {
        let row = try #require(try rows("boise-alerts-inversion-upcoming").first { $0.kind == "inversion" })
        let card = AlertShareCard(row: row, place: boise, official: nil)
        #expect(card.title == "Winter inversion")
        #expect(card.statusText == "Upcoming")
        #expect(card.severityText == "Elevated")
        #expect(card.correctedAqi == 143)
        #expect(card.level == .usg)
        #expect(plain(card.span) == "5 PM to Thu 1 AM")
    }

    @Test("Ozone heads up: low confidence on the card, in words")
    func ozone() throws {
        let row = try #require(try rows("boise-alerts-ozone-heads-up").first)
        let card = AlertShareCard(row: row, place: boise, official: nil)
        #expect(card.title == "Summer ozone")
        #expect(card.severityText == "Heads up")
        #expect(card.correctedAqi == 118)
        #expect(card.lowConfidence)
        #expect(card.summary.contains("Regional and low-confidence"))
    }

    @Test("With an AirNow reading: shown apart, with its credit, never as our number")
    func officialApart() throws {
        let row = try #require(try rows("boise-alerts-smoke-active").first)
        let card = AlertShareCard(row: row, place: boise, official: official)
        let line = try #require(card.official)
        #expect(line.aqi == 48)
        #expect(line.attribution.contains("AirNow"))
        #expect(card.correctedAqi == 168, "our corrected peak stays ours")
        #expect(card.summary.contains("Official AirNow reading, preliminary: 48"))
        #expect(card.summary.contains("Our forecast peaks at air quality index 168"))
    }

    @Test("An AirNow-driven alert states the official reading: the card shows no corrected number")
    func airnowSourced() {
        let reason = "Smoke alert from the latest AirNow PM2.5 reading: AQI 160, valley confidence, across 4 hours."
        #expect(AlertReason.correctedPeak(reason, source: "airnow") == nil)
        #expect(AlertReason.correctedPeak("Smoke alert from the NOAA smoke model: corrected AQI peaks at 120, valley confidence, across 6 hours. AirNow PM2.5 reads 131.", source: "noaa_smoke") == 120)
        #expect(AlertReason.correctedPeak("No number here.", source: "noaa_smoke") == nil)
        #expect(AlertReason.correctedPeak("corrected AQI 999", source: "noaa_smoke") == nil, "out of range is not an AQI")
    }

    @Test("No app name: the mockups' placeholder only")
    func placeholderName() {
        #expect(AlertShareCard.appLabel == "Air Quality Forecast")
    }
}

@MainActor
@Suite("Share card gate and image")
struct ShareCardGateTests {
    @Test("Free gets the paywall; Pro gets the share sheet")
    func gate() async {
        #expect(ShareGate.action(isPro: false) == .paywall)
        let pro = ProModel(provider: FixturePurchaseProvider(now: { SampleAirProvider.now }), now: { SampleAirProvider.now })
        #expect(ShareGate.action(isPro: pro.isPro) == .paywall)
        await pro.buy(ProductIDs.monthly)
        #expect(ShareGate.action(isPro: pro.isPro) == .share)
        #expect(PaywallReason.share.headline == "Sharing alerts is part of Pro")
    }

    @Test("The card renders to a 1080 × 1350 PNG")
    func png() throws {
        let row = try #require(try rows("boise-alerts-smoke-active").first)
        let data = try AlertShareImage(card: AlertShareCard(row: row, place: boise, official: official)).png()
        #expect(data.starts(with: [0x89, 0x50, 0x4E, 0x47]))
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        let props = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        #expect(props[kCGImagePropertyPixelWidth] as? Int == 1080)
        #expect(props[kCGImagePropertyPixelHeight] as? Int == 1350)
    }
}
