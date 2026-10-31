import Foundation

struct Place: Equatable, Sendable {
    let id: String
    let name: String
    let region: String
    /// Times on screen are the place's local time, not the phone's.
    let timeZone: TimeZone
}

/// How far our forecast can see (matches `confidence` in src/lib/v1/types.ts).
enum ForecastConfidence: String, Sendable {
    /// Days 1 and 2 at valley scale.
    case valley
    /// Days 3 to 7 from NOAA's air quality forecast.
    case model
    /// Days 3 to 7, regional and low-confidence.
    case low
}

/// Our corrected number. It is never an AirNow reading.
struct CorrectedForecast: Equatable, Sendable {
    let aqi: Int
    let pollutant: String?
    let validFor: Date
    let issuedAt: Date
    let confidence: ForecastConfidence

    var level: AirLevel { AirLevel(aqi: aqi) }
}

/// The official AirNow reading, shown unaltered, marked preliminary and credited.
/// It has no corrected field, so the two numbers cannot be mixed up.
struct OfficialReading: Equatable, Sendable {
    let aqi: Int
    let observedAt: Date
    let attribution: String
    let preliminary = true

    static let airNowAttribution =
        "Observations courtesy of the U.S. EPA AirNow program (airnow.gov). Preliminary and subject to change."
}

/// Everything the Free home screen shows for one place. The best window and outlook load on their own
/// (`AirDataProvider.bestWindow(for:)`, `outlook(for:)`).
struct HomeSnapshot: Equatable, Sendable {
    let place: Place
    let now: CorrectedForecast
    /// Nil when there is no nearby AirNow monitor or it has not reported.
    let official: OfficialReading?
}
