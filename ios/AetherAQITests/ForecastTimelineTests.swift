import Foundation
import Testing
@testable import AetherAQI

/// The recorded 12Z cycle: from the app bundle when the tests run in the app, else from the source tree.
enum Fixture {
    static func data() throws -> Data {
        if let data = try? FixtureForecastProvider.bundledData() { return data }
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("AetherAQI/Resources/Fixtures/\(FixtureForecastProvider.bundledName).json")
        return try Data(contentsOf: url)
    }

    static func rows() throws -> [ForecastHour] {
        try FixtureForecastProvider(data: data()).rows
    }
}

private let issued = Date(timeIntervalSince1970: 1_793_448_000) // 2026-10-31T12:00:00Z

private func row(
    lead hours: Double, aqi: Int, source: String = "noaa_smoke", horizon: String = "day_1_2_valley", issuedAt: Date = issued
) -> ForecastHour {
    ForecastHour(
        id: "f\(hours)", placeId: "place_boise", source: source, issuedAt: issuedAt,
        validFor: issuedAt.addingTimeInterval(hours * 3600), horizon: horizon,
        spatialScale: "valley", confidence: "valley", correctedAqi: aqi, pollutant: "PM2.5"
    )
}

@Suite("48-hour forecast timeline")
struct ForecastTimelineTests {
    @Test("The recorded cycle: 49 slots, hour 31 empty, the day-3 row left out")
    func fixture() throws {
        let rows = try Fixture.rows()
        #expect(rows.count == 49)
        #expect(rows.contains { $0.source == "noaa_aqf" })
        let timeline = try #require(ForecastTimeline(rows: rows))
        #expect(timeline.issuedAt == issued)
        #expect(timeline.slots.count == 49)
        #expect(timeline.slots.map(\.lead) == Array(0...48))
        #expect(timeline.missingLeads == [31])
        #expect(timeline.slots[0].aqi == 38)
        #expect(timeline.slots[3].aqi == 42)
        #expect(timeline.slots[34].aqi == 182)
        #expect(timeline.slots[48].aqi == 38)
    }

    @Test("Hour 48 is in; anything after it is out, whatever the source")
    func boundaryAt48() throws {
        let timeline = try #require(ForecastTimeline(rows: [
            row(lead: 0, aqi: 10),
            row(lead: 48, aqi: 48),
            row(lead: 49, aqi: 49),
            row(lead: 49, aqi: 56, source: "noaa_aqf", horizon: "day_3_7_noaa_aqf"),
        ]))
        #expect(timeline.slots.count == 49)
        #expect(timeline.slots[48].aqi == 48)
        #expect(timeline.slots.allSatisfy { $0.aqi != 49 && $0.aqi != 56 })
    }

    @Test("Missing hours stay empty: no number is filled in from either side")
    func missingHours() throws {
        let timeline = try #require(ForecastTimeline(rows: [row(lead: 0, aqi: 40), row(lead: 2, aqi: 60)]))
        #expect(timeline.slots[1].aqi == nil)
        #expect(timeline.slots[1].level == nil)
        #expect(timeline.missingLeads == [1] + Array(3...48))
    }

    @Test("Rows the store would not keep are left out")
    func rejectsBadRows() throws {
        let timeline = try #require(ForecastTimeline(rows: [
            row(lead: 0, aqi: 40),
            row(lead: 1, aqi: 41),
            row(lead: 1, aqi: 99), // repeat of hour 1: the first row stays
            row(lead: 2.5, aqi: 77), // not on the hour
            row(lead: -1, aqi: 77), // before the issue time
            row(lead: 3, aqi: 501), // not an AQI
            row(lead: 4, aqi: 64, source: "noaa_aqf", horizon: "day_3_7_noaa_aqf"), // AQF inside 48 h
        ]))
        #expect(timeline.slots[1].aqi == 41)
        #expect(timeline.slots[2].aqi == nil)
        #expect(timeline.slots[3].aqi == nil)
        #expect(timeline.slots[4].aqi == nil)
    }

    @Test("Only the newest cycle is used")
    func newestCycle() throws {
        let older = issued.addingTimeInterval(-6 * 3600)
        let timeline = try #require(ForecastTimeline(rows: [
            row(lead: 6, aqi: 200, issuedAt: older),
            row(lead: 1, aqi: 30),
        ]))
        #expect(timeline.issuedAt == issued)
        #expect(timeline.slots[0].aqi == nil)
        #expect(timeline.slots[1].aqi == 30)
    }

    @Test("No smoke rows means no timeline")
    func emptyRows() {
        #expect(ForecastTimeline(rows: []) == nil)
        #expect(ForecastTimeline(rows: [row(lead: 50, aqi: 56, source: "noaa_aqf", horizon: "day_3_7_noaa_aqf")]) == nil)
        #expect(ForecastTimeline(rows: [row(lead: 60, aqi: 56)]) == nil)
    }

    @Test("Selectable hours run from the current hour to 48, and end once the cycle runs out")
    func selectableLeads() throws {
        let timeline = try #require(ForecastTimeline(rows: [row(lead: 0, aqi: 40)]))
        #expect(timeline.selectableLeads(now: issued.addingTimeInterval(-600)) == 0...48)
        #expect(timeline.selectableLeads(now: issued) == 0...48)
        #expect(timeline.selectableLeads(now: issued.addingTimeInterval(3.5 * 3600)) == 3...48)
        #expect(timeline.selectableLeads(now: issued.addingTimeInterval(48 * 3600)) == 48...48)
        #expect(timeline.selectableLeads(now: issued.addingTimeInterval(49 * 3600)) == nil)
        #expect(timeline.lead(at: issued.addingTimeInterval(47.99 * 3600)) == 47)
    }

    @Test("Store timestamps decode with or without milliseconds")
    func decodesTimes() throws {
        let json = """
        [{"id":"a","placeId":"p","source":"noaa_smoke","issuedAt":"2026-10-31T12:00:00Z","validFor":"2026-10-31T13:00:00.000Z",
          "horizon":"day_1_2_valley","spatialScale":"valley","confidence":"valley","correctedAqi":55,"pollutant":null}]
        """
        let rows = try ForecastHour.decodeRows(Data(json.utf8))
        #expect(rows.first?.issuedAt == issued)
        #expect(rows.first?.validFor == issued.addingTimeInterval(3600))
        #expect(rows.first?.pollutant == nil)
    }
}
