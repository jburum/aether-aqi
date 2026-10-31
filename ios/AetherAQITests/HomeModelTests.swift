import Foundation
import Testing
@testable import AetherAQI

@MainActor
@Suite("Home screen states")
struct HomeModelTests {
    private func loaded(_ scenario: SampleScenario) async -> HomeModel {
        let model = HomeModel(provider: SampleAirProvider(scenario: scenario, delay: .zero))
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
}
