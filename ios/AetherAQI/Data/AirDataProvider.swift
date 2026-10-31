import Foundation

/// Where the home screen gets its air. Only sample and fixture providers exist so far: no network, no keys.
protocol AirDataProvider: Sendable {
    /// The home screen for the user's place, or nil when no place is set yet.
    func homeSnapshot() async throws -> HomeSnapshot?

    /// Stored forecast rows for `place`, shaped like `IssuedForecast` in src/lib/v1/types.ts. The rows
    /// may include days 3–7; `ForecastTimeline` keeps the newest cycle's NOAA smoke hours 0 through 48.
    func hourlyForecast(for place: Place) async throws -> [ForecastHour]
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

/// Fixed sample data for Boise, Idaho. Our corrected number and the AirNow reading differ on purpose,
/// so a screen that mixes them up is easy to spot.
struct SampleAirProvider: AirDataProvider {
    var scenario: SampleScenario = .good
    var timeline: SampleTimeline = .fixture
    /// Simulated latency, so the loading states are visible on launch.
    var delay: Duration = .milliseconds(350)
    /// The recorded rows. Tests and still renders pass the file in directly.
    var fixtureData: @Sendable () throws -> Data = { try FixtureForecastProvider.bundledData() }

    /// The sample clock: 15:00Z, three hours into the fixture's 12Z NOAA cycle.
    static let issuedAt = Date(timeIntervalSince1970: 1_793_458_800) // 2026-10-31T15:00:00Z
    static let now = issuedAt
    static let boise = Place(id: "place_boise", name: "Boise", region: "Idaho", timeZone: TimeZone(identifier: "America/Boise")!)

    func homeSnapshot() async throws -> HomeSnapshot? {
        if scenario == .loading {
            try await Task.sleep(for: .seconds(60 * 60 * 24))
        }
        if delay > .zero { try await Task.sleep(for: delay) }
        switch scenario {
        case .empty: return nil
        case .error: throw AirDataError.unavailable
        case .loading, .good, .moderate, .usg, .unhealthy, .very, .hazardous:
            let ours = Self.ours[scenario] ?? 42
            return Self.snapshot(ours: ours, official: Self.official[scenario] ?? nil, pollutant: scenario == .moderate ? "Ozone" : "PM2.5")
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

    static func snapshot(ours: Int, official: Int?, pollutant: String) -> HomeSnapshot {
        HomeSnapshot(
            place: boise,
            now: CorrectedForecast(aqi: ours, pollutant: pollutant, validFor: issuedAt, issuedAt: issuedAt, confidence: .valley),
            official: official.map {
                OfficialReading(aqi: $0, observedAt: issuedAt.addingTimeInterval(-40 * 60), attribution: OfficialReading.airNowAttribution)
            },
            bestWindow: nil
        )
    }
}
