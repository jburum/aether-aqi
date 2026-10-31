import Foundation
import Testing
@testable import AetherAQI

@MainActor
@Suite("Home screen states")
struct HomeModelTests {
    private func loaded(_ scenario: SampleScenario, timeline: SampleTimeline = .fixture) async -> HomeModel {
        let provider = SampleAirProvider(scenario: scenario, timeline: timeline, delay: .zero, fixtureData: { try Fixture.data() })
        let model = HomeModel(provider: provider, now: { SampleAirProvider.now })
        await model.load()
        return model
    }

    @Test("Starts in loading, with the neutral field")
    func startsLoading() {
        let model = HomeModel(provider: SampleAirProvider())
        #expect(model.state == .loading)
        #expect(model.level == nil)
    }

    @Test("A place with air: the level of our corrected number tints the app")
    func loadedTintsByOurNumber() async throws {
        let model = await loaded(.usg)
        guard case .loaded(let snapshot) = model.state else { Issue.record("not loaded"); return }
        #expect(model.level == .usg)
        #expect(model.level == AirLevel(aqi: snapshot.now.aqi))
    }

    @Test("Official AirNow stays separate: its own value, preliminary and credited")
    func officialSeparate() async throws {
        let model = await loaded(.good)
        guard case .loaded(let snapshot) = model.state else { Issue.record("not loaded"); return }
        let official = try #require(snapshot.official)
        #expect(official.aqi != snapshot.now.aqi, "sample numbers differ so a mix-up shows")
        #expect(official.preliminary)
        #expect(official.attribution.contains("AirNow"))
    }

    @Test("No nearby AirNow monitor still loads our number")
    func noOfficial() async {
        let model = await loaded(.hazardous)
        guard case .loaded(let snapshot) = model.state else { Issue.record("not loaded"); return }
        #expect(snapshot.official == nil)
        #expect(model.level == .hazardous)
    }

    @Test("No place set: empty state, neutral field")
    func empty() async {
        let model = await loaded(.empty)
        #expect(model.state == .empty)
        #expect(model.level == nil)
    }

    @Test("A failed load shows the error state and drops the old number")
    func failureDropsOldNumber() async {
        let provider = FlakyProvider()
        let model = HomeModel(provider: provider)
        await model.load()
        #expect(model.level == .good)
        await provider.fail()
        await model.load()
        #expect(model.state == .failed)
        #expect(model.level == nil)
    }

    @Test("Scenario comes from the launch argument, defaulting to good")
    func scenarioFromLaunch() throws {
        let defaults = try #require(UserDefaults(suiteName: "HomeModelTests.scenario"))
        defer { defaults.removePersistentDomain(forName: "HomeModelTests.scenario") }
        #expect(SampleScenario.fromLaunchArguments(defaults) == .good)
        defaults.set("error", forKey: SampleScenario.launchKey)
        #expect(SampleScenario.fromLaunchArguments(defaults) == .error)
        defaults.set("nonsense", forKey: SampleScenario.launchKey)
        #expect(SampleScenario.fromLaunchArguments(defaults) == .good)
    }
}

private actor FlakyProvider: AirDataProvider {
    private var failing = false

    func fail() { failing = true }

    func homeSnapshot() async throws -> HomeSnapshot? {
        if failing { throw AirDataError.unavailable }
        return SampleAirProvider.snapshot(ours: 30, official: 35, pollutant: "PM2.5")
    }

    func hourlyForecast(for place: Place) async throws -> [ForecastHour] {
        if failing { throw AirDataError.unavailable }
        return []
    }
}

/// Answers the home screen, and fails the forecast until `recover()`.
private actor TimelineFailsOnceProvider: AirDataProvider {
    private var failing = true

    func recover() { failing = false }

    func homeSnapshot() async throws -> HomeSnapshot? {
        SampleAirProvider.snapshot(ours: 42, official: 48, pollutant: "PM2.5")
    }

    func hourlyForecast(for place: Place) async throws -> [ForecastHour] {
        if failing { throw AirDataError.unavailable }
        return try Fixture.rows()
    }
}

@MainActor
@Suite("48-hour timeline on the home screen")
struct TimelineSelectionTests {
    private func model(
        _ scenario: SampleScenario = .good, timeline: SampleTimeline = .fixture, now: Date = SampleAirProvider.now
    ) async -> HomeModel {
        let provider = SampleAirProvider(scenario: scenario, timeline: timeline, delay: .zero, fixtureData: { try Fixture.data() })
        let model = HomeModel(provider: provider, now: { now })
        await model.load()
        return model
    }

    @Test("Opens on the current hour, which matches the current number")
    func opensOnNow() async throws {
        let model = await model()
        #expect(model.nowLead == 3)
        #expect(model.selectedLead == 3)
        #expect(model.selectableLeads == 3...48)
        guard case .forecast(let slot, let isNow) = model.selection else { Issue.record("no selection"); return }
        #expect(isNow)
        #expect(slot.aqi == 42)
        #expect(model.level == .good)
    }

    @Test("Each level scenario's timeline reads its number at the current hour")
    func scenarioTimelineMatchesNow() async {
        let model = await model(.usg)
        guard case .forecast(let slot, _) = model.selection else { Issue.record("no selection"); return }
        #expect(slot.aqi == 128)
        #expect(model.level == .usg)
    }

    @Test("Selecting an hour moves the hero, the level and the field")
    func selectHour() async {
        let model = await model()
        #expect(model.select(lead: 34))
        guard case .forecast(let slot, let isNow) = model.selection else { Issue.record("no selection"); return }
        #expect(!isNow)
        #expect(slot.aqi == 182)
        #expect(model.shownLevel == .unhealthy)
        #expect(model.level == .unhealthy)
    }

    @Test("Selection stops at the 48-hour lead and at the current hour")
    func boundaries() async {
        let model = await model()
        #expect(model.select(lead: 60))
        #expect(model.selectedLead == 48)
        #expect(!model.step(by: 1), "nothing after hour 48")
        #expect(model.selectedLead == 48)
        #expect(model.step(by: -1))
        #expect(model.selectedLead == 47)
        model.select(lead: 0)
        #expect(model.selectedLead == 3, "past hours are not selectable")
        #expect(!model.step(by: -1))
    }

    @Test("An hour with no forecast shows no number and the neutral field")
    func missingHour() async {
        let model = await model()
        model.select(lead: 31)
        guard case .missing(let slot, _) = model.selection else { Issue.record("expected a missing hour"); return }
        #expect(slot.aqi == nil)
        #expect(model.shownLevel == nil)
        #expect(model.level == nil)
        model.step(by: 1)
        #expect(model.level == .unhealthy, "hour 32 is 151")
    }

    @Test("While dragging, the field holds; on release it follows the selected hour")
    func scrubHoldsField() async {
        let model = await model()
        model.beginScrub()
        model.select(lead: 34)
        #expect(model.shownLevel == .unhealthy)
        #expect(model.level == .good)
        model.select(lead: 44)
        #expect(model.level == .good)
        model.endScrub()
        #expect(model.level == .moderate, "hour 44 is 51")
    }

    @Test("Back to now returns to the current hour")
    func backToNow() async {
        let model = await model()
        model.select(lead: 20)
        model.selectNow()
        #expect(model.selectedLead == 3)
    }

    @Test("No forecast rows: the timeline is empty and the current number still shows")
    func emptyTimeline() async {
        let model = await model(timeline: .empty)
        #expect(model.timelineState == .empty)
        #expect(model.selection == nil)
        #expect(model.level == .good)
        #expect(!model.select(lead: 10))
    }

    @Test("A failed forecast request leaves the current number up and can be retried")
    func failedTimeline() async throws {
        let provider = TimelineFailsOnceProvider()
        let model = HomeModel(provider: provider, now: { SampleAirProvider.now })
        await model.load()
        #expect(model.timelineState == .failed)
        #expect(model.level == .good)
        await provider.recover()
        await model.reloadTimeline()
        #expect(model.timeline != nil)
        #expect(model.selectedLead == 3)
    }

    @Test("A cycle that no longer covers now is hidden, not shown as current")
    func outdatedTimeline() async {
        let model = await model(now: SampleAirProvider.now.addingTimeInterval(47 * 3600))
        #expect(model.timelineState == .outdated)
        #expect(model.selection == nil)
    }

    @Test("No place: no timeline either")
    func noPlace() async {
        let model = await model(.empty)
        #expect(model.timelineState == .empty)
    }
}
