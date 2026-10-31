import Foundation
import Testing
@testable import AetherAQI

private let boise = SampleAirProvider.boise

private func loadAlerts(_ name: String) throws -> AlertsDisplay {
    AlertsDisplay(try StoreJSON.decoder().decode(AlertsResponse.self, from: Fixture.data(named: name)), fallbackZone: boise.timeZone)
}

/// Date formats put a narrow no-break space before AM/PM; compare with plain spaces.
private func plain(_ text: String) -> String {
    text.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
}

@Suite("Alerts from the fixtures")
struct AlertsFixtureTests {
    @Test("Smoke active: one high row, now, with its span in Boise time and the rule's reason")
    func smokeActive() throws {
        let alerts = try loadAlerts("boise-alerts-smoke-active")
        #expect(alerts.rows.count == 1)
        let row = try #require(alerts.rows.first)
        #expect(row.title == "Smoke")
        #expect(row.severityText == "High")
        #expect(row.swatch == .unhealthy)
        #expect(row.isActive)
        #expect(row.statusText == "Now")
        #expect(!row.lowConfidence)
        // 13:00Z to 20:00Z on 31 Oct is 7 AM to 2 PM in Boise (MDT).
        #expect(plain(row.span) == "7 AM to 2 PM")
        #expect(row.reason.hasPrefix("Smoke alert from the NOAA smoke model"))
    }

    @Test("Winter: the active smoke alert comes first, then the upcoming inversion")
    func activeBeforeUpcoming() throws {
        let alerts = try loadAlerts("boise-alerts-inversion-upcoming")
        #expect(alerts.rows.map(\.kind) == ["smoke", "inversion"])
        #expect(alerts.rows.map(\.isActive) == [true, false])
        let inversion = alerts.rows[1]
        #expect(inversion.title == "Winter inversion")
        #expect(inversion.statusText == "Upcoming")
        #expect(inversion.severityText == "Elevated")
        #expect(inversion.swatch == .usg)
        // 00:00Z to 08:00Z on 3 Dec is 5 PM to 1 AM in Boise (MST): it runs past midnight.
        #expect(plain(inversion.span) == "5 PM to Thu 1 AM")
        #expect(!inversion.lowConfidence)
        // The reason is the final rule's (#15 at 8f4522f): HRRR mixing height, not an 80 m lapse.
        #expect(inversion.reason == "Winter inversion across 8 hours: mixing height is 180 m, wind is 1.1 m/s, and PM2.5 corrected AQI peaks at 143.")
    }

    @Test("Ozone heads up: upcoming, labeled regional and low-confidence, with no severity color")
    func ozoneHeadsUp() throws {
        let alerts = try loadAlerts("boise-alerts-ozone-heads-up")
        let row = try #require(alerts.rows.first)
        #expect(row.title == "Summer ozone")
        #expect(row.severityText == "Heads up")
        #expect(row.swatch == nil)
        #expect(row.lowConfidence)
        #expect(!row.isActive)
        #expect(row.accessibilityLabel.contains("Regional and low-confidence"))
        #expect(plain(row.span).hasPrefix("Sat 1 PM"))
    }

    @Test("An empty list is one calm line")
    func empty() throws {
        let alerts = try loadAlerts("boise-alerts-empty")
        #expect(alerts.isEmpty)
        #expect(AlertsDisplay.emptyText == "No smoke, inversion or ozone alerts in the next 7 days.")
    }

    @Test("Quiet, ended and timeless decisions are left out; low confidence alone marks a row")
    func filtering() throws {
        let json = """
        {"placeId":"p","asOf":"2026-10-31T15:00:00.000Z","timeZone":"America/Boise","through":"2026-11-07T15:00:00.000Z","alerts":[
         {"kind":"smoke","fired":false,"status":"quiet","start":null,"end":null,"severity":null,"source":null,"confidence":null,"reason":"No smoke alert."},
         {"kind":"smoke","fired":true,"status":"active","start":"2026-10-31T10:00:00.000Z","end":"2026-10-31T15:00:00.000Z","severity":"elevated","source":"noaa_smoke","confidence":"valley","reason":"over"},
         {"kind":"ozone","fired":true,"status":"upcoming","start":"2026-11-03T20:00:00.000Z","end":"2026-11-03T23:00:00.000Z","severity":"elevated","source":"noaa_aqf","confidence":"low","reason":"odd"}
        ]}
        """
        let alerts = AlertsDisplay(try StoreJSON.decoder().decode(AlertsResponse.self, from: Data(json.utf8)), fallbackZone: boise.timeZone)
        #expect(alerts.rows.map(\.reason) == ["odd"])
        #expect(alerts.rows.first?.lowConfidence == true)
    }
}

@MainActor
@Suite("Alert settings")
struct AlertSettingsTests {
    private func fresh(_ name: String) throws -> UserDefaults {
        let defaults = try #require(UserDefaults(suiteName: name))
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    @Test("Every rule is off until the person turns it on")
    func defaultsOff() throws {
        let defaults = try fresh("AlertSettingsTests.defaults")
        let settings = AlertSettings(defaults: defaults)
        for rule in AlertRule.allCases { #expect(!settings.isOn(rule), "\(rule)") }
        #expect(settings.enabled.isEmpty)
        #expect(AlertRule.allCases == [.smoke, .inversion, .ozone])
    }

    @Test("A switch is kept on this phone, per rule, and can be turned off again")
    func persists() throws {
        let name = "AlertSettingsTests.persists"
        let defaults = try fresh(name)
        defer { defaults.removePersistentDomain(forName: name) }
        let settings = AlertSettings(defaults: defaults)
        settings.set(.inversion, on: true)
        #expect(AlertSettings(defaults: defaults).enabled == [.inversion])
        settings.set(.inversion, on: false)
        #expect(AlertSettings(defaults: defaults).enabled.isEmpty)
        #expect(defaults.object(forKey: AlertSettings.key(.smoke)) == nil)
    }

    @Test("A stored value that isn't true stays off")
    func strict() throws {
        let name = "AlertSettingsTests.strict"
        let defaults = try fresh(name)
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("yes", forKey: AlertSettings.key(.ozone))
        #expect(!AlertSettings(defaults: defaults).isOn(.ozone))
    }
}

@MainActor
@Suite("Alerts on the home screen")
struct AlertsModelTests {
    private func model(_ scenario: SampleAlerts) async -> HomeModel {
        let provider = SampleAirProvider(
            timeline: .fixture,
            delay: .zero,
            fixtureData: { try Fixture.data() },
            responseData: { try Fixture.data(named: $0) },
            alertsScenario: scenario
        )
        let model = HomeModel(provider: provider, now: { SampleAirProvider.now })
        await model.load()
        return model
    }

    @Test("Alerts load beside the rest of the screen")
    func loads() async {
        let model = await model(.winter)
        guard case .loaded(let alerts) = model.alertsState else { Issue.record("alerts \(model.alertsState)"); return }
        #expect(alerts.rows.count == 2)
        #expect(model.timeline != nil)
    }

    @Test("A failed alerts request shows its own error and nothing else changes")
    func failure() async {
        let model = await model(.error)
        #expect(model.alertsState == .failed)
        #expect(model.level == .good)
        #expect(model.timeline != nil)
    }

    @Test("Empty alerts load as an empty list, not an error")
    func empty() async {
        guard case .loaded(let alerts) = await model(.empty).alertsState else { Issue.record("not loaded"); return }
        #expect(alerts.isEmpty)
    }

    @Test("The alerts scenario comes from the launch argument, defaulting to smoke")
    func scenarioFromLaunch() throws {
        let defaults = try #require(UserDefaults(suiteName: "AlertsModelTests.scenario"))
        defer { defaults.removePersistentDomain(forName: "AlertsModelTests.scenario") }
        #expect(SampleAlerts.fromLaunchArguments(defaults) == .smoke)
        defaults.set("ozone", forKey: SampleAlerts.launchKey)
        #expect(SampleAlerts.fromLaunchArguments(defaults) == .ozone)
    }
}

@MainActor
@Suite("Alerts load on their own")
struct IndependentAlertsTests {
    @Test("Stalled alerts don't hold back the timeline, window or outlook; stalled others don't hold back alerts")
    func independence() async {
        for (stalled, ready): (StallingProvider.Section, (HomeModel) -> Bool) in [
            (.alerts, { $0.timeline != nil && $0.outlookState != .loading && $0.bestWindowState != .loading }),
            (.timeline, { $0.alertsState != .loading }),
            (.outlook, { $0.alertsState != .loading }),
        ] {
            let model = HomeModel(provider: StallingProvider(stalled: [stalled]), now: { SampleAirProvider.now })
            let load = Task { await model.load() }
            for _ in 0..<400 where !ready(model) { try? await Task.sleep(for: .milliseconds(5)) }
            load.cancel()
            #expect(ready(model), "stalled \(stalled)")
            if stalled == .alerts { #expect(model.alertsState == .loading) }
        }
    }
}
