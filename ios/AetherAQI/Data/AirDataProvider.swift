import Foundation

/// Where the home screen gets its air. Phase 0 ships only `SampleAirProvider`: no network, no keys.
protocol AirDataProvider: Sendable {
    /// The home screen for the user's place, or nil when no place is set yet.
    func homeSnapshot() async throws -> HomeSnapshot?
}

enum AirDataError: Error, Equatable {
    case unavailable
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

/// Fixed sample data for Boise, Idaho. Our corrected number and the AirNow reading differ on purpose,
/// so a screen that mixes them up is easy to spot.
struct SampleAirProvider: AirDataProvider {
    var scenario: SampleScenario = .good
    /// Simulated latency, so the loading state is visible on launch.
    var delay: Duration = .milliseconds(350)

    static let issuedAt = Date(timeIntervalSince1970: 1_793_458_800) // 2026-10-31T15:00:00Z
    static let boise = Place(id: "place_boise", name: "Boise", region: "Idaho", timeZone: TimeZone(identifier: "America/Boise")!)

    func homeSnapshot() async throws -> HomeSnapshot? {
        if scenario == .loading {
            try await Task.sleep(for: .seconds(60 * 60 * 24))
        }
        if delay > .zero { try await Task.sleep(for: delay) }
        switch scenario {
        case .empty: return nil
        case .error: throw AirDataError.unavailable
        case .loading, .good: return Self.snapshot(ours: 42, official: 48, pollutant: "PM2.5")
        case .moderate: return Self.snapshot(ours: 74, official: 68, pollutant: "Ozone")
        case .usg: return Self.snapshot(ours: 128, official: 117, pollutant: "PM2.5")
        case .unhealthy: return Self.snapshot(ours: 172, official: 158, pollutant: "PM2.5")
        case .very: return Self.snapshot(ours: 243, official: 221, pollutant: "PM2.5")
        case .hazardous: return Self.snapshot(ours: 352, official: nil, pollutant: "PM2.5")
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
