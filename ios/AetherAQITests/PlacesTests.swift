import Foundation
import Testing
@testable import AetherAQI

private let suite = "PlacesTests"

/// A clean UserDefaults per test, removed again afterwards by `done`.
private func freshDefaults(_ name: String) throws -> UserDefaults {
    let defaults = try #require(UserDefaults(suiteName: "\(suite).\(name)"))
    defaults.removePersistentDomain(forName: "\(suite).\(name)")
    return defaults
}

private func candidates() throws -> [PlaceCandidate] {
    try IdahoPlaces.decode(Fixture.data(named: IdahoPlaces.fixtureName))
}

private func candidate(_ name: String) throws -> PlaceCandidate {
    try #require(try candidates().first { $0.name == name })
}

@MainActor
private func places(_ defaults: UserDefaults, pro: Bool) async throws -> PlacesModel {
    let model = PlacesModel(
        provider: LocalPlacesProvider(defaults: defaults),
        candidates: try candidates(),
        isPro: pro,
        defaults: defaults,
        now: { SampleAirProvider.now }
    )
    await model.load()
    return model
}

@Suite("Idaho places fixture")
struct IdahoPlacesFixtureTests {
    @Test("Decodes the bundled list in the saved_place shape, with a zone for each")
    func decodes() throws {
        let all = try candidates()
        #expect(all.count == 21)
        #expect(Set(all.map(\.name)).count == all.count)
        for name in ["Boise", "McCall", "Donnelly", "Tamarack"] { #expect(all.contains { $0.name == name }, "\(name)") }
        for place in all {
            #expect(TimeZone(identifier: place.timeZone) != nil, "\(place.name)")
            #expect((41.9...49.1).contains(place.latitude), "\(place.name)")
            #expect((-117.3 ... -111.0).contains(place.longitude), "\(place.name)")
        }
        // North Idaho is on Pacific time.
        #expect(try candidate("Coeur d'Alene").timeZone == "America/Los_Angeles")
    }
}

@MainActor
@Suite("Saved places")
struct PlacesModelTests {
    @Test("First run has Boise, active, and nothing else")
    func firstRun() async throws {
        let model = try await places(try freshDefaults("firstRun"), pro: false)
        #expect(model.places.map(\.name) == ["Boise"])
        #expect(model.active?.id == "place_boise")
        #expect(model.activePlace?.timeZone.identifier == "America/Boise")
        #expect(model.addable.contains { $0.name == "Boise" } == false)
    }

    @Test("Pro keeps up to 5: the sixth is refused at the cap, in the model and the store")
    func cap() async throws {
        let defaults = try freshDefaults("cap")
        let model = try await places(defaults, pro: true)
        for name in ["McCall", "Donnelly", "Tamarack", "Ketchum"] {
            #expect(await model.add(try candidate(name)), "\(name)")
        }
        #expect(model.places.count == PlaceLimits.maxSaved)
        #expect(model.isAtCap)
        #expect(!model.canAdd)
        #expect(!(await model.add(try candidate("Stanley"))))
        #expect(model.problem == .atCap)
        #expect(model.places.count == 5)
        // The store enforces the cap on its own too, as the server's trigger does.
        await #expect(throws: PlaceProblem.atCap) {
            _ = try await LocalPlacesProvider(defaults: defaults).add(try candidate("Stanley"), now: SampleAirProvider.now)
        }
        #expect(PlaceProblem.atCap.message.contains("5 places"))
    }

    @Test("Free keeps one place: adding a second needs Pro and writes nothing")
    func freeAllowance() async throws {
        let defaults = try freshDefaults("free")
        let model = try await places(defaults, pro: false)
        #expect(model.addNeedsPro)
        #expect(!model.canAdd)
        #expect(!(await model.add(try candidate("McCall"))))
        #expect(model.problem == .needsPro)
        #expect(try await LocalPlacesProvider(defaults: defaults).list().count == 1)
    }

    @Test("A place already saved is refused")
    func duplicate() async throws {
        let model = try await places(try freshDefaults("duplicate"), pro: true)
        #expect(!(await model.add(try candidate("Boise"))))
        #expect(model.problem == .alreadySaved)
    }

    @Test("Picking a place makes it active and keeps the choice")
    func activeSwitch() async throws {
        let defaults = try freshDefaults("active")
        let model = try await places(defaults, pro: true)
        await model.add(try candidate("McCall"))
        let mccall = try #require(model.places.first { $0.name == "McCall" })
        #expect(model.activate(mccall.id))
        #expect(model.active?.id == mccall.id)
        #expect(model.activePlace?.name == "McCall")
        let again = try await places(defaults, pro: true)
        #expect(again.active?.id == mccall.id)
    }

    @Test("On Free, only the first place can be active (a second one stays from Pro days)")
    func freeActive() async throws {
        let defaults = try freshDefaults("freeActive")
        let pro = try await places(defaults, pro: true)
        await pro.add(try candidate("McCall"))
        let mccall = try #require(pro.places.first { $0.name == "McCall" })
        pro.activate(mccall.id)
        let free = try await places(defaults, pro: false)
        #expect(free.active?.name == "Boise")
        #expect(!free.activate(mccall.id))
        #expect(free.problem == .needsPro)
    }

    @Test("Deleting the active place falls back to the first; deleting the last leaves none")
    func delete() async throws {
        let defaults = try freshDefaults("delete")
        let model = try await places(defaults, pro: true)
        await model.add(try candidate("McCall"))
        await model.add(try candidate("Ketchum"))
        let ketchum = try #require(model.places.first { $0.name == "Ketchum" })
        model.activate(ketchum.id)
        #expect(await model.delete(ketchum.id))
        #expect(model.active?.name == "Boise")
        #expect(model.places.map(\.position) == [0, 1])
        for place in model.places { await model.delete(place.id) }
        #expect(model.places.isEmpty)
        #expect(model.active == nil)
        #expect(model.activePlace == nil)
        #expect(model.canAdd)
        // Kept: an empty list does not come back as Boise.
        #expect(try await places(defaults, pro: true).places.isEmpty)
    }

    @Test("Rename trims, refuses empty and long names, and is kept")
    func rename() async throws {
        let defaults = try freshDefaults("rename")
        let model = try await places(defaults, pro: false)
        #expect(await model.rename("place_boise", to: "  Home  "))
        #expect(model.places.first?.name == "Home")
        #expect(!(await model.rename("place_boise", to: "   ")))
        #expect(model.problem == .emptyName)
        #expect(!(await model.rename("place_boise", to: String(repeating: "x", count: 61))))
        #expect(model.problem == .nameTooLong)
        #expect(try await places(defaults, pro: false).places.first?.name == "Home")
        // The renamed place keeps its zone.
        #expect(model.activePlace?.timeZone.identifier == "America/Boise")
    }

    @Test("The Pro stub is off unless the launch argument turns it on")
    func proStub() throws {
        let defaults = try freshDefaults("pro")
        #expect(!ProStub.isOn(defaults))
        defaults.set(true, forKey: ProStub.launchKey)
        #expect(ProStub.isOn(defaults))
    }
}

/// Answers instantly, except for one place whose snapshot arrives late.
private struct SlowPlaceProvider: AirDataProvider {
    let slowId: String
    let base = SampleAirProvider(
        timeline: .fixture, delay: .zero, fixtureData: { try Fixture.data() }, responseData: { try Fixture.data(named: $0) }
    )

    func homeSnapshot(for place: Place) async throws -> HomeSnapshot? {
        if place.id == slowId { try await Task.sleep(for: .milliseconds(200)) }
        return try await base.homeSnapshot(for: place)
    }
    func hourlyForecast(for place: Place) async throws -> [ForecastHour] { try await base.hourlyForecast(for: place) }
    func bestWindow(for place: Place) async throws -> BestWindowResponse { try await base.bestWindow(for: place) }
    func outlook(for place: Place) async throws -> OutlookResponse { try await base.outlook(for: place) }
    func alerts(for place: Place) async throws -> AlertsResponse { try await base.alerts(for: place) }
}

@MainActor
@Suite("The home screen follows the active place")
struct HomeFollowsPlaceTests {
    private let mccall = Place(id: "place_mccall", name: "McCall", region: "Idaho", timeZone: TimeZone(identifier: "America/Boise")!)
    private let cda = Place(id: "place_cda", name: "Coeur d'Alene", region: "Idaho", timeZone: TimeZone(identifier: "America/Los_Angeles")!)

    @Test("Showing a place loads the screen for it")
    func follows() async {
        let model = HomeModel(provider: SlowPlaceProvider(slowId: ""), now: { SampleAirProvider.now })
        await model.show(mccall)
        guard case .loaded(let snapshot) = model.state else { Issue.record("not loaded"); return }
        #expect(snapshot.place == mccall)
        #expect(model.place == mccall)
    }

    @Test("Showing the place the model started with still loads it the first time, and not again after")
    func firstShowLoads() async {
        let model = HomeModel(provider: SlowPlaceProvider(slowId: ""), now: { SampleAirProvider.now })
        #expect(model.place == SampleAirProvider.boise)
        await model.show(SampleAirProvider.boise)
        guard case .loaded = model.state else { Issue.record("first show did not load"); return }
        model.select(lead: 20)
        await model.show(SampleAirProvider.boise)
        #expect(model.selectedLead == 20, "a repeat show of the same place keeps the screen as it is")
    }

    @Test("No active place is the empty state")
    func noPlace() async {
        let model = HomeModel(provider: SlowPlaceProvider(slowId: ""), now: { SampleAirProvider.now })
        await model.show(nil)
        #expect(model.state == .empty)
        #expect(model.level == nil)
    }

    @Test("A slow answer for the previous place never replaces the place picked after it")
    func staleAnswer() async throws {
        let model = HomeModel(provider: SlowPlaceProvider(slowId: mccall.id), now: { SampleAirProvider.now }, place: nil)
        let first = Task { await model.show(mccall) }
        try await Task.sleep(for: .milliseconds(20))
        await model.show(cda)
        await first.value
        guard case .loaded(let snapshot) = model.state else { Issue.record("not loaded"); return }
        #expect(snapshot.place == cda)
        #expect(model.place == cda)
    }
}
