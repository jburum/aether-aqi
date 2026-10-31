import Foundation
import Testing
@testable import AetherAQI

private let boise = SampleAirProvider.boise

/// Date formats put a narrow no-break space before AM/PM; compare with plain spaces.
private func plain(_ text: String) -> String {
    text.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
}

private func loadWindow(_ name: String) throws -> BestWindowResponse {
    try StoreJSON.decoder().decode(BestWindowResponse.self, from: Fixture.data(named: name))
}

private func loadOutlook(_ name: String) throws -> OutlookResponse {
    try StoreJSON.decoder().decode(OutlookResponse.self, from: Fixture.data(named: name))
}

/// One outlook day as the API writes it.
private func dayJSON(_ date: String, _ weekday: String, summary: String) -> String {
    #"{"date":"\#(date)","weekday":"\#(weekday)","summary":\#(summary)}"#
}

private let valleySummary =
    #"{"worstCorrectedAqi":60,"typicalCorrectedAqi":40,"band":"moderate","confidence":"valley","spatialScale":"valley","horizon":"day_1_2_valley","label":"valley"}"#

@Suite("Best window")
struct BestWindowTests {
    @Test("A window reads start to end in the place's time, with its band, peak and sources")
    func window() throws {
        let response = try loadWindow("boise-best-window")
        guard case .window(let raw) = response.bestWindow else { Issue.record("expected a window"); return }
        #expect(raw.band == .good)
        #expect(raw.peakCorrectedAqi == 50)
        let display = BestWindowDisplay(response, place: boise)
        // 15:00Z to 03:00Z is 9 AM to 9 PM in Boise (MDT), the same Saturday as asOf.
        guard case .window(let span, let level, let peak, let sources) = display.state else { Issue.record("expected a window"); return }
        #expect(plain(span) == "9 AM to 9 PM")
        #expect(level == .good)
        #expect(peak == 50)
        #expect(sources == "NOAA smoke model")
        #expect(plain(display.accessibilityLabel).contains("9 AM to 9 PM"))
        #expect(display.accessibilityLabel.contains("Good"))
    }

    @Test("A window into the next day names the day it ends on")
    func windowAcrossMidnight() throws {
        let display = BestWindowDisplay(try loadWindow("boise-best-window-weekday"), place: boise)
        // 03:00Z Nov 5 is 8 PM Wednesday in Boise (MST); 19:00Z is noon Thursday.
        guard case .window(let span, _, _, _) = display.state else { Issue.record("expected a window"); return }
        #expect(plain(span) == "8 PM to Thu 12 PM")
    }

    @Test("\"none\" is a calm empty state, not an error")
    func noneWindow() throws {
        let response = try loadWindow("boise-best-window-none")
        #expect(response.bestWindow == .none)
        let display = BestWindowDisplay(response, place: boise)
        #expect(display.state == .none)
        #expect(display.accessibilityLabel.contains("no forecast hours"))
    }

    @Test("Any string other than \"none\" is refused")
    func strictNone() {
        let json = #"{"placeId":"p","asOf":"2026-10-31T15:00:00.000Z","through":"2026-11-02T15:00:00.000Z","bestWindow":"nothing"}"#
        #expect(throws: DecodingError.self) { try StoreJSON.decoder().decode(BestWindowResponse.self, from: Data(json.utf8)) }
    }

    @Test("Source names read in words, in order")
    func sources() {
        #expect(ForecastSourceName.list(["noaa_smoke"]) == "NOAA smoke model")
        #expect(ForecastSourceName.list(["noaa_smoke", "noaa_aqf"]) == "NOAA smoke model and NOAA air quality forecast")
    }
}

@Suite("Outlook")
struct OutlookTests {
    @Test("A day past 48 hours is regional and low-confidence, never valley")
    func lowConfidenceDay() throws {
        let display = OutlookDisplay(try loadOutlook("boise-outlook-weekday"), fallbackZone: boise.timeZone)
        guard case .summary(let worst, let typical, let level, let valley) = display.saturday.state else {
            Issue.record("expected a Saturday summary"); return
        }
        #expect(!valley)
        #expect(worst == 136)
        #expect(typical == 103)
        #expect(level == .usg)
        #expect(display.saturday.accessibilityLabel.contains("Regional and low-confidence"))
        guard case .summary(_, _, _, let tomorrowValley) = display.tomorrow.state else { Issue.record("expected tomorrow"); return }
        #expect(tomorrowValley)
        #expect(display.tomorrow.relation == "Tomorrow")
        #expect(display.tomorrow.accessibilityLabel.contains("Valley forecast"))
    }

    @Test("A label or confidence this app doesn't know is shown as low-confidence")
    func unknownLabel() throws {
        let odd = #"{"worstCorrectedAqi":60,"typicalCorrectedAqi":40,"band":"moderate","confidence":"valley","spatialScale":"valley","horizon":"day_1_2_valley","label":"something new"}"#
        let mixed = #"{"worstCorrectedAqi":60,"typicalCorrectedAqi":40,"band":"moderate","confidence":"low","spatialScale":"valley","horizon":"day_1_2_valley","label":"valley"}"#
        for summary in [odd, mixed] {
            let day = try JSONDecoder().decode(OutlookDay.self, from: Data(dayJSON("2026-11-01", "sunday", summary: summary).utf8))
            guard case .summary(let value) = day.summary else { Issue.record("expected a summary"); continue }
            #expect(!value.isValley)
        }
    }

    @Test("A \"no data\" day gets the empty state")
    func noDataDay() throws {
        let display = OutlookDisplay(try loadOutlook("boise-outlook-weekday"), fallbackZone: boise.timeZone)
        #expect(display.sunday.state == .noData)
        #expect(display.sunday.relation == "Sunday")
        #expect(display.sunday.accessibilityLabel.contains("no forecast yet"))
    }

    @Test("On Saturday, the weekend is today and tomorrow")
    func weekendFromSaturday() throws {
        let display = OutlookDisplay(try loadOutlook("boise-outlook-weekend"), fallbackZone: boise.timeZone)
        #expect(display.saturday.relation == "Today")
        #expect(display.sunday.relation == "Tomorrow")
        #expect(display.tomorrow.relation == "Tomorrow")
        #expect(display.saturday.dateText.contains("Oct 31"))
        // Sunday Nov 1 is the day clocks fall back in Boise; it is still Nov 1.
        #expect(display.sunday.dateText.contains("Nov 1"))
    }

    @Test("On Sunday, the weekend is yesterday and today, as the API sends it")
    func weekendFromSunday() throws {
        let json = """
        {"placeId":"place_boise","timeZone":"America/Boise","asOf":"2026-11-01T18:00:00.000Z",
         "tomorrow":\(dayJSON("2026-11-02", "monday", summary: valleySummary)),
         "weekend":{"saturday":\(dayJSON("2026-10-31", "saturday", summary: valleySummary)),
                    "sunday":\(dayJSON("2026-11-01", "sunday", summary: valleySummary))}}
        """
        let display = OutlookDisplay(try StoreJSON.decoder().decode(OutlookResponse.self, from: Data(json.utf8)), fallbackZone: boise.timeZone)
        #expect(display.saturday.relation == "Yesterday")
        #expect(display.sunday.relation == "Today")
        #expect(display.tomorrow.relation == "Tomorrow")
    }

    @Test("Any summary string other than \"no data\" is refused")
    func strictNoData() {
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(OutlookDay.self, from: Data(dayJSON("2026-11-01", "sunday", summary: #""none""#).utf8))
        }
    }

    @Test("The bands decode by name; very is its own band")
    func bands() throws {
        for level in AirLevel.allCases {
            let decoded = try JSONDecoder().decode([AirLevel].self, from: Data(#"["\#(level.rawValue)"]"#.utf8))
            #expect(decoded == [level])
        }
        #expect(AirLevel(rawValue: "very") == .very)
        #expect(AirLevel(aqi: 201) == .very)
        #expect(AirLevel(aqi: 300) == .very)
    }
}

@MainActor
@Suite("Best window and outlook on the home screen")
struct WindowOutlookModelTests {
    private func model(_ scenario: SampleOutlook) async -> HomeModel {
        let provider = SampleAirProvider(
            timeline: .fixture,
            delay: .zero,
            fixtureData: { try Fixture.data() },
            outlookScenario: scenario,
            responseData: { try Fixture.data(named: $0) }
        )
        let model = HomeModel(provider: provider, now: { SampleAirProvider.now })
        await model.load()
        return model
    }

    @Test("Both load beside the current number")
    func loads() async {
        let model = await model(.weekend)
        guard case .loaded(let window) = model.bestWindowState else { Issue.record("no window"); return }
        #expect(window.state != .none)
        guard case .loaded(let outlook) = model.outlookState else { Issue.record("no outlook"); return }
        #expect(outlook.saturday.relation == "Today")
    }

    @Test("A none window and a weekday outlook")
    func noneAndWeekday() async {
        #expect(await model(.none).bestWindowState == .loaded(BestWindowDisplay(try! loadWindow("boise-best-window-none"), place: boise)))
        guard case .loaded(let outlook) = await model(.weekday).outlookState else { Issue.record("no outlook"); return }
        #expect(outlook.sunday.state == .noData)
    }

    @Test("A failure shows its own error and leaves the current number and timeline up")
    func failure() async {
        let model = await model(.error)
        #expect(model.bestWindowState == .failed)
        #expect(model.outlookState == .failed)
        #expect(model.level == .good)
        #expect(model.timeline != nil)
    }

    @Test("Never mixes in the official number: the window comes from our forecast only")
    func correctedOnly() async throws {
        // The sample's AirNow reading is 48; the window's peak is our corrected 50.
        let model = await model(.weekend)
        guard case .loaded(let snapshot) = model.state, case .loaded(let window) = model.bestWindowState,
              case .window(_, _, let peak, _) = window.state else { Issue.record("not loaded"); return }
        #expect(snapshot.official?.aqi == 48)
        #expect(peak == 50)
    }

    @Test("The outlook scenario comes from the launch argument, defaulting to weekend")
    func scenarioFromLaunch() throws {
        let defaults = try #require(UserDefaults(suiteName: "WindowOutlookModelTests.scenario"))
        defer { defaults.removePersistentDomain(forName: "WindowOutlookModelTests.scenario") }
        #expect(SampleOutlook.fromLaunchArguments(defaults) == .weekend)
        defaults.set("weekday", forKey: SampleOutlook.launchKey)
        #expect(SampleOutlook.fromLaunchArguments(defaults) == .weekday)
    }
}

/// Answers like the sample provider, but the sections named in `stalled` never answer (until cancelled).
struct StallingProvider: AirDataProvider {
    enum Section: Sendable { case timeline, window, outlook, alerts }
    let stalled: Set<Section>
    let base = SampleAirProvider(
        timeline: .fixture,
        delay: .zero,
        fixtureData: { try Fixture.data() },
        outlookScenario: .weekday,
        responseData: { try Fixture.data(named: $0) }
    )

    private func stall(_ section: Section) async throws {
        if stalled.contains(section) { try await Task.sleep(for: .seconds(60 * 60)) }
    }

    func homeSnapshot(for place: Place) async throws -> HomeSnapshot? { try await base.homeSnapshot(for: place) }
    func hourlyForecast(for place: Place) async throws -> [ForecastHour] {
        try await stall(.timeline)
        return try await base.hourlyForecast(for: place)
    }
    func bestWindow(for place: Place) async throws -> BestWindowResponse {
        try await stall(.window)
        return try await base.bestWindow(for: place)
    }
    func outlook(for place: Place) async throws -> OutlookResponse {
        try await stall(.outlook)
        return try await base.outlook(for: place)
    }
    func alerts(for place: Place) async throws -> AlertsResponse {
        try await stall(.alerts)
        return try await base.alerts(for: place)
    }
}

@MainActor
@Suite("Sections load on their own (Dex, PR 14 at 05abf90)")
struct IndependentSectionTests {
    /// Starts a load that will not finish (one section stalls), waits for `ready`, then cancels it.
    private func whileStalled(_ stalled: Set<StallingProvider.Section>, until ready: (HomeModel) -> Bool) async -> HomeModel {
        let model = HomeModel(provider: StallingProvider(stalled: stalled), now: { SampleAirProvider.now })
        let load = Task { await model.load() }
        for _ in 0..<400 where !ready(model) {
            try? await Task.sleep(for: .milliseconds(5))
        }
        load.cancel()
        return model
    }

    @Test("A stalled timeline doesn't hold back the best window or the outlook")
    func timelineStalls() async {
        let model = await whileStalled([.timeline]) { $0.outlookState != .loading && $0.bestWindowState != .loading }
        #expect(model.timelineState == .loading)
        guard case .loaded = model.bestWindowState else { Issue.record("window still \(model.bestWindowState)"); return }
        guard case .loaded(let outlook) = model.outlookState else { Issue.record("outlook still \(model.outlookState)"); return }
        #expect(outlook.sunday.state == .noData)
    }

    @Test("A stalled best window doesn't hide a finished outlook")
    func windowStalls() async {
        let model = await whileStalled([.window]) { $0.outlookState != .loading && $0.timeline != nil }
        #expect(model.bestWindowState == .loading)
        guard case .loaded = model.outlookState else { Issue.record("outlook still \(model.outlookState)"); return }
        #expect(model.timeline != nil)
    }

    @Test("A stalled outlook doesn't hold back the best window or the timeline, and the field still follows the timeline")
    func outlookStalls() async {
        let model = await whileStalled([.outlook]) { $0.bestWindowState != .loading && $0.timeline != nil }
        #expect(model.outlookState == .loading)
        guard case .loaded = model.bestWindowState else { Issue.record("window still \(model.bestWindowState)"); return }
        #expect(model.selectedLead == 3)
        #expect(model.level == .good)
    }
}
