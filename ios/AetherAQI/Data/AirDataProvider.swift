import Foundation

/// Where the home screen gets its air. Only sample and fixture providers exist so far: no network, no keys.
protocol AirDataProvider: Sendable {
    /// The home screen for `place` (the active saved place), or nil when there is no air for it yet.
    func homeSnapshot(for place: Place) async throws -> HomeSnapshot?

    /// Stored forecast rows for `place`, shaped like `IssuedForecast` in src/lib/v1/types.ts. The rows
    /// may include days 3–7; `ForecastTimeline` keeps the newest cycle's NOAA smoke hours 0 through 48.
    func hourlyForecast(for place: Place) async throws -> [ForecastHour]

    /// GET /api/v1/places/:id/best-window: the best time outside in the next 48 hours, or "none".
    func bestWindow(for place: Place) async throws -> BestWindowResponse

    /// GET /api/v1/places/:id/outlook?timeZone=: tomorrow and this weekend in the place's zone.
    func outlook(for place: Place) async throws -> OutlookResponse

    /// GET /api/v1/places/:id/alerts?timeZone=: smoke, inversion and ozone alerts, active or upcoming.
    func alerts(for place: Place) async throws -> AlertsResponse
}

/// A recorded response from the bundle. `name` is the file name without `.json`.
enum BundledFixture {
    static func data(named name: String, bundle: Bundle = .main) throws -> Data {
        guard let url = bundle.url(forResource: name, withExtension: "json") else { throw AirDataError.unavailable }
        return try Data(contentsOf: url)
    }
}

enum AirDataError: Error, Equatable {
    case unavailable
}

/// Rows from a recorded JSON file in the store's shape. A live provider swaps the file for a request
/// that returns the same rows.
struct FixtureForecastProvider: Sendable {
    static let bundledName = "boise-hourly-12z"

    let rows: [ForecastHour]

    init(data: Data) throws {
        rows = try ForecastHour.decodeRows(data)
    }

    static func bundledData(_ bundle: Bundle = .main) throws -> Data {
        guard let url = bundle.url(forResource: bundledName, withExtension: "json") else {
            throw AirDataError.unavailable
        }
        return try Data(contentsOf: url)
    }
}

/// Which canned screen the sample provider returns. Pick one at launch with `-AQIScenario <name>`.
enum SampleScenario: String, CaseIterable, Sendable {
    case good, moderate, usg, unhealthy, very, hazardous
    /// No place set.
    case empty
    /// The provider fails.
    case error
    /// The provider never answers, so the loading state stays up.
    case loading

    static let launchKey = "AQIScenario"

    static func fromLaunchArguments(_ defaults: UserDefaults = .standard) -> SampleScenario {
        defaults.string(forKey: launchKey).flatMap(SampleScenario.init(rawValue:)) ?? .good
    }
}

/// What the 48-hour timeline gets from the sample provider. Pick one at launch with `-AQITimeline <name>`.
enum SampleTimeline: String, CaseIterable, Sendable {
    /// The recorded 12Z cycle (hour 31 has no value), moved so the current hour matches the scenario's number.
    case fixture
    /// No forecast rows for this place yet.
    case empty
    /// The forecast request fails.
    case error
    /// The forecast request never answers.
    case loading

    static let launchKey = "AQITimeline"

    static func fromLaunchArguments(_ defaults: UserDefaults = .standard) -> SampleTimeline {
        defaults.string(forKey: launchKey).flatMap(SampleTimeline.init(rawValue:)) ?? .fixture
    }
}

/// The best window and outlook the sample provider returns. Pick one at launch with `-AQIOutlook <name>`.
/// The responses were built with the back end's own `bestWindowFromHours` and `outlookFromHours`.
enum SampleOutlook: String, CaseIterable, Sendable {
    /// Saturday 9 AM: window 9 AM to 9 PM, tomorrow and both weekend days in the valley.
    case weekend
    /// Wednesday: Thursday in the valley, Saturday regional and low-confidence, Sunday with no data.
    case weekday
    /// No forecast hour in the next 48 hours: the window is "none".
    case none
    /// Both requests fail.
    case error
    /// Both requests never answer.
    case loading

    static let launchKey = "AQIOutlook"

    static func fromLaunchArguments(_ defaults: UserDefaults = .standard) -> SampleOutlook {
        defaults.string(forKey: launchKey).flatMap(SampleOutlook.init(rawValue:)) ?? .weekend
    }
}

/// The alerts the sample provider returns. Pick one at launch with `-AQIAlerts <name>`. The responses
/// were built with the back end's own smokeRule, inversionRule and ozoneRule (keel/aqi-p2-alert-rules).
enum SampleAlerts: String, CaseIterable, Sendable {
    /// Saturday 31 Oct: smoke active, high.
    case smoke
    /// 2 Dec: smoke active (elevated), then a valley inversion tonight (upcoming).
    case winter
    /// 8 Jul: ozone on days 3–7, a low-confidence heads up.
    case ozone
    /// Nothing active or upcoming.
    case empty
    case error
    case loading

    static let launchKey = "AQIAlerts"

    static func fromLaunchArguments(_ defaults: UserDefaults = .standard) -> SampleAlerts {
        defaults.string(forKey: launchKey).flatMap(SampleAlerts.init(rawValue:)) ?? .smoke
    }

    var fixture: String? {
        switch self {
        case .smoke: "boise-alerts-smoke-active"
        case .winter: "boise-alerts-inversion-upcoming"
        case .ozone: "boise-alerts-ozone-heads-up"
        case .empty: "boise-alerts-empty"
        case .error, .loading: nil
        }
    }
}

/// Fixed sample data for Boise, Idaho. Our corrected number and the AirNow reading differ on purpose,
/// so a screen that mixes them up is easy to spot.
struct SampleAirProvider: AirDataProvider {
    var scenario: SampleScenario = .good
    var timeline: SampleTimeline = .fixture
    /// Simulated latency, so the loading states are visible on launch.
    var delay: Duration = .milliseconds(350)
    /// The recorded rows. Tests and still renders pass the file in directly.
    var fixtureData: @Sendable () throws -> Data = { try FixtureForecastProvider.bundledData() }
    var outlookScenario: SampleOutlook = .weekend
    /// Recorded best-window and outlook responses by fixture name. Tests and renders read the files directly.
    var responseData: @Sendable (String) throws -> Data = { try BundledFixture.data(named: $0) }
    var alertsScenario: SampleAlerts = .smoke

    /// The sample clock: 15:00Z, three hours into the fixture's 12Z NOAA cycle.
    static let issuedAt = Date(timeIntervalSince1970: 1_793_458_800) // 2026-10-31T15:00:00Z
    static let now = issuedAt
    static let boise = Place(id: "place_boise", name: "Boise", region: "Idaho", timeZone: TimeZone(identifier: "America/Boise")!)

    /// Sample numbers are Boise's for every place: the place's name and zone change, the air does not.
    func homeSnapshot(for place: Place) async throws -> HomeSnapshot? {
        if scenario == .loading {
            try await Task.sleep(for: .seconds(60 * 60 * 24))
        }
        if delay > .zero { try await Task.sleep(for: delay) }
        switch scenario {
        case .empty: return nil
        case .error: throw AirDataError.unavailable
        case .loading, .good, .moderate, .usg, .unhealthy, .very, .hazardous:
            let ours = Self.ours[scenario] ?? 42
            return Self.snapshot(ours: ours, official: Self.official[scenario] ?? nil, pollutant: scenario == .moderate ? "Ozone" : "PM2.5", place: place)
        }
    }

    func hourlyForecast(for place: Place) async throws -> [ForecastHour] {
        if timeline == .loading {
            try await Task.sleep(for: .seconds(60 * 60 * 24))
        }
        if delay > .zero { try await Task.sleep(for: delay * 2) }
        switch timeline {
        case .empty: return []
        case .error: throw AirDataError.unavailable
        case .fixture, .loading:
            let rows = try FixtureForecastProvider(data: fixtureData()).rows
            return Self.shifted(rows, toMatch: Self.ours[scenario] ?? 42)
        }
    }

    func bestWindow(for place: Place) async throws -> BestWindowResponse {
        try await phase2Wait()
        let name = switch outlookScenario {
        case .weekend, .loading, .error: "boise-best-window"
        case .weekday: "boise-best-window-weekday"
        case .none: "boise-best-window-none"
        }
        return try StoreJSON.decoder().decode(BestWindowResponse.self, from: responseData(name))
    }

    func outlook(for place: Place) async throws -> OutlookResponse {
        try await phase2Wait()
        let name = outlookScenario == .weekday ? "boise-outlook-weekday" : "boise-outlook-weekend"
        return try StoreJSON.decoder().decode(OutlookResponse.self, from: responseData(name))
    }

    func alerts(for place: Place) async throws -> AlertsResponse {
        if alertsScenario == .loading { try await Task.sleep(for: .seconds(60 * 60 * 24)) }
        if delay > .zero { try await Task.sleep(for: delay * 2) }
        guard let name = alertsScenario.fixture else { throw AirDataError.unavailable }
        return try StoreJSON.decoder().decode(AlertsResponse.self, from: responseData(name))
    }

    private func phase2Wait() async throws {
        if outlookScenario == .loading { try await Task.sleep(for: .seconds(60 * 60 * 24)) }
        if delay > .zero { try await Task.sleep(for: delay * 2) }
        if outlookScenario == .error { throw AirDataError.unavailable }
    }

    private static let ours: [SampleScenario: Int] = [.good: 42, .moderate: 74, .usg: 128, .unhealthy: 172, .very: 243, .hazardous: 352]
    private static let official: [SampleScenario: Int?] = [.good: 48, .moderate: 68, .usg: 117, .unhealthy: 158, .very: 221, .hazardous: nil]

    /// Moves every row by the same amount so the hour at `now` reads `aqi`, keeping the fixture's shape.
    static func shifted(_ rows: [ForecastHour], toMatch aqi: Int) -> [ForecastHour] {
        guard let current = rows.first(where: { $0.source == ForecastHour.smokeSource && $0.validFor == now }) else { return rows }
        let offset = aqi - current.correctedAqi
        guard offset != 0 else { return rows }
        return rows.map { row in
            ForecastHour(
                id: row.id, placeId: row.placeId, source: row.source, issuedAt: row.issuedAt, validFor: row.validFor,
                horizon: row.horizon, spatialScale: row.spatialScale, confidence: row.confidence,
                correctedAqi: min(500, max(0, row.correctedAqi + offset)), pollutant: row.pollutant
            )
        }
    }

    static func snapshot(ours: Int, official: Int?, pollutant: String, place: Place = boise) -> HomeSnapshot {
        HomeSnapshot(
            place: place,
            now: CorrectedForecast(aqi: ours, pollutant: pollutant, validFor: issuedAt, issuedAt: issuedAt, confidence: .valley),
            official: official.map {
                OfficialReading(aqi: $0, observedAt: issuedAt.addingTimeInterval(-40 * 60), attribution: OfficialReading.airNowAttribution)
            }
        )
    }
}
