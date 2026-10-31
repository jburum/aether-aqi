import Foundation

// The Pro alert share card: an image of one active or upcoming alert, for the share sheet. Our corrected
// forecast and the official AirNow number stay apart on it, as on the home screen.

/// What the card shows for one alert.
struct AlertShareCard: Equatable, Sendable {
    /// The app name is still open (docs/appstore/ROADMAP.md): the mockups' placeholder.
    static let appLabel = "Air Quality Forecast"
    static let forecastNote = "Our forecast, not an official reading."

    let placeName: String
    let placeRegion: String
    /// "Smoke", "Winter inversion", "Summer ozone".
    let title: String
    /// "High", "Elevated", "Heads up".
    let severityText: String
    /// "Now" or "Upcoming".
    let statusText: String
    /// "7 AM to 2 PM", in the place's zone.
    let span: String
    /// Our corrected peak (`peakAqi` on the alert). Nil for an AirNow-driven alert: never an AirNow number.
    let correctedAqi: Int?
    let lowConfidence: Bool
    /// The official AirNow reading for the place, shown apart with its credit. Nil hides that panel.
    let official: OfficialLine?

    struct OfficialLine: Equatable, Sendable {
        let aqi: Int
        let observed: String
        let attribution: String
    }

    /// The card's color: the band of our corrected peak, or the severity's band when there is no number.
    var level: AirLevel? {
        if let correctedAqi { return AirLevel(aqi: correctedAqi) }
        return AlertsDisplay.swatch(severityKey)
    }

    private let severityKey: String

    init(row: AlertRowDisplay, place: Place, official: OfficialReading?) {
        placeName = place.name
        placeRegion = place.region
        title = row.title
        severityText = row.severityText
        severityKey = row.severityKey
        statusText = row.statusText
        span = row.span
        correctedAqi = row.correctedPeak
        lowConfidence = row.lowConfidence
        self.official = official.map { reading in
            var style = Date.FormatStyle(date: .omitted, time: .shortened)
            style.timeZone = place.timeZone
            return OfficialLine(aqi: reading.aqi, observed: reading.observedAt.formatted(style), attribution: reading.attribution)
        }
    }

    /// One sentence for VoiceOver and the share preview.
    var summary: String {
        var parts = ["\(title) alert for \(placeName), \(severityText.lowercased()), \(statusText.lowercased()): \(span)"]
        if let correctedAqi, let level { parts.append("Our forecast peaks at air quality index \(correctedAqi), \(level.label)") }
        if lowConfidence { parts.append("Regional and low-confidence") }
        parts.append(Self.forecastNote)
        if let official { parts.append("Official AirNow reading, preliminary: \(official.aqi), observed \(official.observed)") }
        return parts.joined(separator: ". ")
    }
}

/// Sharing is Pro: Free gets the paywall instead.
enum ShareGate {
    enum Action: Equatable { case share, paywall }

    static func action(isPro: Bool) -> Action { isPro ? .share : .paywall }
}
