import Foundation

// Phase 2 reads, shaped exactly after GET /api/v1/places/:id/best-window and /outlook
// (docs/v1/PHASE2.md, src/lib/v1/phase2.ts). Both use our corrected forecast only; the official AirNow
// number is never an input, and nothing here reads it.

/// The API's `band` values are the air level names (`very` is 201–300).
extension AirLevel: Codable {}

/// GET /api/v1/places/:id/best-window
struct BestWindowResponse: Decodable, Equatable, Sendable {
    let placeId: String
    let asOf: Date
    /// Inclusive end of the next 48 hours.
    let through: Date
    let bestWindow: BestWindowValue
}

/// `bestWindow` is a window object, or the string "none" when no stored hour falls in the next 48 hours.
enum BestWindowValue: Decodable, Equatable, Sendable {
    case none
    case window(OutdoorWindow)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let text = try? container.decode(String.self) {
            guard text == "none" else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "bestWindow string must be \"none\", not \(text)")
            }
            self = .none
        } else {
            self = .window(try container.decode(OutdoorWindow.self))
        }
    }
}

struct OutdoorWindow: Decodable, Equatable, Sendable {
    /// First stored hour in the run.
    let start: Date
    /// One hour after the last stored hour.
    let end: Date
    let peakCorrectedAqi: Int
    let band: AirLevel
    /// `noaa_smoke`, `noaa_aqf` or `regional`, in time order, once each.
    let sources: [String]
}

/// GET /api/v1/places/:id/outlook
struct OutlookResponse: Decodable, Equatable, Sendable {
    let placeId: String
    let timeZone: String
    let asOf: Date
    let tomorrow: OutlookDay
    let weekend: Weekend

    struct Weekend: Decodable, Equatable, Sendable {
        let saturday: OutlookDay
        let sunday: OutlookDay
    }
}

struct OutlookDay: Decodable, Equatable, Sendable {
    /// Local calendar date in the outlook's zone, `YYYY-MM-DD`.
    let date: String
    /// Lowercase English weekday, e.g. `saturday`.
    let weekday: String
    let summary: DaySummaryValue
}

/// A day's `summary` is a summary object, or the string "no data" when no hour is stored for that day.
enum DaySummaryValue: Decodable, Equatable, Sendable {
    case noData
    case summary(DaySummary)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let text = try? container.decode(String.self) {
            guard text == "no data" else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "summary string must be \"no data\", not \(text)")
            }
            self = .noData
        } else {
            self = .summary(try container.decode(DaySummary.self))
        }
    }
}

struct DaySummary: Decodable, Equatable, Sendable {
    let worstCorrectedAqi: Int
    let typicalCorrectedAqi: Int
    /// Band of the worst value.
    let band: AirLevel
    let confidence: String
    let spatialScale: String
    let horizon: String
    /// `valley` or `regional and low-confidence`.
    let label: String

    static let valleyLabel = "valley"
    static let lowConfidenceLabel = "regional and low-confidence"

    /// Valley confidence only when every field says so. Anything else, including a value this app does
    /// not know, is shown as regional and low-confidence: never styled like a valley forecast.
    var isValley: Bool {
        label == Self.valleyLabel && confidence == "valley" && spatialScale == "valley" && horizon == "day_1_2_valley"
    }
}

/// Words for the forecast sources a window was built from.
enum ForecastSourceName {
    static func label(_ source: String) -> String {
        switch source {
        case "noaa_smoke": "NOAA smoke model"
        case "noaa_aqf": "NOAA air quality forecast"
        case "regional": "regional guidance"
        default: source
        }
    }

    static func list(_ sources: [String]) -> String {
        sources.map(label).formatted(.list(type: .and))
    }
}

// MARK: - What the screens show

/// "9 AM to 9 PM", "8 PM to Thu 12 PM": a span with an exclusive end, in a place's local time.
enum LocalSpan {
    /// The start names its day when it isn't `asOf`'s day; the end names its day when the span runs past
    /// midnight. An end exactly at midnight still belongs to the start's day.
    static func text(start: Date, end: Date, zone: TimeZone, asOf: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let startText = calendar.isDate(start, inSameDayAs: asOf)
            ? HourLabel.hour(start, in: zone)
            : HourLabel.dayAndHour(start, in: zone)
        let lastMoment = end.addingTimeInterval(-1)
        let endText = calendar.isDate(lastMoment, inSameDayAs: start)
            ? HourLabel.hour(end, in: zone)
            : HourLabel.dayAndHour(end, in: zone)
        return "\(startText) to \(endText)"
    }
}

/// The home screen's best-window line.
struct BestWindowDisplay: Equatable, Sendable {
    enum State: Equatable, Sendable {
        /// "Sat 9 AM to 9 PM", the band of the peak, the peak itself, and where it came from.
        case window(span: String, level: AirLevel, peak: Int, sources: String)
        /// No stored hour in the next 48 hours.
        case none
    }

    let state: State

    init(_ response: BestWindowResponse, place: Place) {
        switch response.bestWindow {
        case .none:
            state = .none
        case .window(let window):
            state = .window(
                span: Self.span(window, zone: place.timeZone, asOf: response.asOf),
                level: window.band,
                peak: window.peakCorrectedAqi,
                sources: ForecastSourceName.list(window.sources)
            )
        }
    }

    /// Start to end in the place's local time. The day is named when it is not today, and again at the
    /// end when the window runs past midnight.
    static func span(_ window: OutdoorWindow, zone: TimeZone, asOf: Date) -> String {
        LocalSpan.text(start: window.start, end: window.end, zone: zone, asOf: asOf)
    }

    var accessibilityLabel: String {
        switch state {
        case .none:
            "Best time outside: no forecast hours in the next 48 hours yet."
        case .window(let span, let level, let peak, let sources):
            "Best time outside: \(span). Our forecast peaks at air quality index \(peak), \(level.label). From the \(sources)."
        }
    }
}

/// One day in the outlook, ready to show.
struct OutlookDayDisplay: Equatable, Sendable {
    enum State: Equatable, Sendable {
        case summary(worst: Int, typical: Int, level: AirLevel, valley: Bool)
        case noData
    }

    /// "Tomorrow", "Today", "Yesterday", or the weekday.
    let relation: String
    /// "Sun, Nov 1"
    let dateText: String
    let state: State

    init(_ day: OutlookDay, asOf: Date, zone: TimeZone) {
        let date = Self.localDate(day.date, zone: zone)
        relation = date.map { Self.relation($0, asOf: asOf, zone: zone) } ?? day.weekday.capitalized
        dateText = date.map { Self.dateText($0, zone: zone) } ?? day.date
        switch day.summary {
        case .noData:
            state = .noData
        case .summary(let summary):
            state = .summary(worst: summary.worstCorrectedAqi, typical: summary.typicalCorrectedAqi, level: summary.band, valley: summary.isValley)
        }
    }

    /// Noon of a `YYYY-MM-DD` date in `zone`, so a DST change never moves it to another day.
    static func localDate(_ text: String, zone: TimeZone) -> Date? {
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }

    static func relation(_ date: Date, asOf: Date, zone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: asOf), to: calendar.startOfDay(for: date)).day ?? 0
        switch days {
        case -1: return "Yesterday"
        case 0: return "Today"
        case 1: return "Tomorrow"
        default:
            var style = Date.FormatStyle(date: .omitted, time: .omitted).weekday(.wide)
            style.timeZone = zone
            return date.formatted(style)
        }
    }

    static func dateText(_ date: Date, zone: TimeZone) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .omitted).weekday(.abbreviated).month(.abbreviated).day()
        style.timeZone = zone
        return date.formatted(style)
    }

    var accessibilityLabel: String {
        let head = "\(relation), \(dateText)"
        switch state {
        case .noData:
            return "\(head): no forecast yet."
        case .summary(let worst, let typical, let level, let valley):
            let confidence = valley ? "Valley forecast." : "Regional and low-confidence forecast."
            return "\(head): worst air quality index \(worst), \(level.label). Typical \(typical). \(confidence)"
        }
    }
}

/// The outlook view: Tomorrow, then this weekend's Saturday and Sunday.
struct OutlookDisplay: Equatable, Sendable {
    let tomorrow: OutlookDayDisplay
    let saturday: OutlookDayDisplay
    let sunday: OutlookDayDisplay

    init(_ response: OutlookResponse, fallbackZone: TimeZone) {
        let zone = TimeZone(identifier: response.timeZone) ?? fallbackZone
        tomorrow = OutlookDayDisplay(response.tomorrow, asOf: response.asOf, zone: zone)
        saturday = OutlookDayDisplay(response.weekend.saturday, asOf: response.asOf, zone: zone)
        sunday = OutlookDayDisplay(response.weekend.sunday, asOf: response.asOf, zone: zone)
    }
}
