import Foundation
import Observation

// GET /api/v1/places/:id/alerts (docs/v1/ALERTS.md and `AlertsResponse` in src/lib/v1/alerts.ts on
// keel/aqi-p2-alert-rules). Smoke, winter inversion and summer ozone, from our corrected forecast.

struct AlertsResponse: Decodable, Equatable, Sendable {
    let placeId: String
    let asOf: Date
    let timeZone: String
    /// `asOf` plus seven days.
    let through: Date
    /// Fired rules only. An empty list means nothing is active or upcoming.
    let alerts: [PlaceAlert]
}

/// One rule's decision (`AlertDecision`). A quiet rule has null start, end, severity, source and confidence.
struct PlaceAlert: Decodable, Equatable, Sendable {
    /// `smoke`, `inversion` or `ozone`.
    let kind: String
    let fired: Bool
    /// `active`, `upcoming` or `quiet`.
    let status: String
    let start: Date?
    /// Exclusive.
    let end: Date?
    /// `elevated`, `high` or `heads_up`.
    let severity: String?
    let source: String?
    let confidence: String?
    let reason: String
}

/// The three rules the person can turn on.
enum AlertRule: String, CaseIterable, Sendable {
    case smoke, inversion, ozone

    var title: String {
        switch self {
        case .smoke: "Smoke"
        case .inversion: "Winter inversion"
        case .ozone: "Summer ozone"
        }
    }

    /// One line under the switch in Alert settings.
    var detail: String {
        switch self {
        case .smoke: "Wildfire smoke at or above 101 for 3 hours."
        case .inversion: "November to February, when cold air traps smoke and haze in the valley."
        case .ozone: "May to September, when afternoon ozone builds."
        }
    }
}

/// One row in the home screen's alert list.
struct AlertRowDisplay: Equatable, Sendable, Identifiable {
    var id: String { "\(kind)-\(span)" }

    let kind: String
    let title: String
    /// "High", "Elevated", "Heads up".
    let severityText: String
    /// The color a severity swatch borrows from the AQI bands. Nil for a heads up.
    let swatch: AirLevel?
    let isActive: Bool
    /// "Now", "Upcoming".
    let statusText: String
    let span: String
    let reason: String
    /// Days 3–7, or a confidence of `low`: shown as regional and low-confidence, in words.
    let lowConfidence: Bool

    var accessibilityLabel: String {
        var parts = ["\(title) alert, \(statusText.lowercased()), \(severityText.lowercased())", span]
        if lowConfidence { parts.append("Regional and low-confidence") }
        parts.append(reason)
        return parts.joined(separator: ". ")
    }
}

/// The alert list: active first, then upcoming by start. Rows that are quiet, already over, or missing
/// a time are left out.
struct AlertsDisplay: Equatable, Sendable {
    let rows: [AlertRowDisplay]

    var isEmpty: Bool { rows.isEmpty }

    static let emptyText = "No smoke, inversion or ozone alerts in the next 7 days."

    init(_ response: AlertsResponse, fallbackZone: TimeZone) {
        let zone = TimeZone(identifier: response.timeZone) ?? fallbackZone
        let asOf = response.asOf
        let current = response.alerts.compactMap { alert -> (PlaceAlert, Date, Date)? in
            guard alert.fired, let start = alert.start, let end = alert.end, end > asOf else { return nil }
            return (alert, start, end)
        }
        let ordered = current.sorted { a, b in
            let aActive = a.1 <= asOf
            let bActive = b.1 <= asOf
            if aActive != bActive { return aActive }
            return a.1 < b.1
        }
        rows = ordered.map { alert, start, end in
            let active = start <= asOf
            let severity = alert.severity ?? ""
            return AlertRowDisplay(
                kind: alert.kind,
                title: AlertRule(rawValue: alert.kind)?.title ?? alert.kind.capitalized,
                severityText: Self.severityText(severity),
                swatch: Self.swatch(severity),
                isActive: active,
                statusText: active ? "Now" : "Upcoming",
                span: LocalSpan.text(start: start, end: end, zone: zone, asOf: asOf),
                reason: alert.reason,
                lowConfidence: severity == "heads_up" || alert.confidence == "low"
            )
        }
    }

    static func severityText(_ severity: String) -> String {
        switch severity {
        case "high": "High"
        case "elevated": "Elevated"
        case "heads_up": "Heads up"
        default: "Alert"
        }
    }

    /// Elevated borrows the USG color and high the Unhealthy color. A heads up has none.
    static func swatch(_ severity: String) -> AirLevel? {
        switch severity {
        case "high": .unhealthy
        case "elevated": .usg
        default: nil
        }
    }
}

/// Which alerts the person has turned on, kept on this phone only (UserDefaults). Every rule is off until
/// the person turns it on (docs/appstore/ROADMAP.md). Nothing here asks for notification permission or
/// sends anything.
@MainActor
@Observable
final class AlertSettings {
    private let defaults: UserDefaults
    private(set) var enabled: Set<AlertRule>

    static func key(_ rule: AlertRule) -> String { "alerts.\(rule.rawValue).enabled" }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        enabled = Set(AlertRule.allCases.filter { defaults.object(forKey: Self.key($0)) as? Bool == true })
    }

    func isOn(_ rule: AlertRule) -> Bool { enabled.contains(rule) }

    func set(_ rule: AlertRule, on: Bool) {
        if on { enabled.insert(rule) } else { enabled.remove(rule) }
        defaults.set(on, forKey: Self.key(rule))
    }

    /// Alerts are Pro. Turning one on without Pro changes nothing and returns false: show the paywall.
    /// Turning one off always works.
    @discardableResult
    func request(_ rule: AlertRule, on: Bool, isPro: Bool) -> Bool {
        if on && !isPro { return false }
        set(rule, on: on)
        return true
    }

    /// What the switch shows. A choice kept from Pro days reads off while the person is on Free.
    func shownOn(_ rule: AlertRule, isPro: Bool) -> Bool {
        isPro && isOn(rule)
    }
}
