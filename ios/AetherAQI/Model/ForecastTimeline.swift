import Foundation

/// One stored forecast row, shaped like `IssuedForecast` in src/lib/v1/types.ts so a live endpoint
/// that returns those rows decodes as-is.
struct ForecastHour: Codable, Equatable, Sendable {
    let id: String
    let placeId: String
    /// `noaa_smoke`, `noaa_aqf` or `regional`.
    let source: String
    let issuedAt: Date
    let validFor: Date
    let horizon: String
    let spatialScale: String
    let confidence: String
    let correctedAqi: Int
    let pollutant: String?

    static let smokeSource = "noaa_smoke"
    static let valleyHorizon = "day_1_2_valley"

    /// Decodes the store's ISO 8601 timestamps, with or without milliseconds (`toISOString()` writes them).
    static func decodeRows(_ data: Data) throws -> [ForecastHour] {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            let withMillis = ISO8601DateFormatter()
            withMillis.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
            if let date = withMillis.date(from: text) ?? plain.date(from: text) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not an ISO 8601 time: \(text)"))
        }
        return try decoder.decode([ForecastHour].self, from: data)
    }
}

/// The 48-hour hourly timeline: our corrected NOAA smoke forecast for lead hours 0 through 48 of one
/// cycle, one slot per hour. A slot with no row (NOAA left that cell empty) stays empty; no number is filled in.
struct ForecastTimeline: Equatable, Sendable {
    /// Days 1–2 run through the 48-hour lead, including that hour (`classifyForecastLead` in rules.ts).
    static let lastLead = 48

    struct Slot: Equatable, Sendable {
        let lead: Int
        let validFor: Date
        let aqi: Int?
        let pollutant: String?

        var level: AirLevel? { aqi.map(AirLevel.init(aqi:)) }
    }

    let issuedAt: Date
    /// Exactly `lastLead + 1` slots; `slots[lead].lead == lead`.
    let slots: [Slot]

    /// Builds the timeline from the newest cycle in `rows`. Rows from other cycles, other sources
    /// (days 3–7 are `noaa_aqf` or `regional`), off-hour times, leads past 48 and AQI outside 0–500
    /// are left out. A repeated hour keeps the first row, as the store refuses the second.
    init?(rows: [ForecastHour]) {
        let smoke = rows.filter { $0.source == ForecastHour.smokeSource && $0.horizon == ForecastHour.valleyHorizon }
        guard let issuedAt = smoke.map(\.issuedAt).max() else { return nil }
        var byLead: [Int: ForecastHour] = [:]
        for row in smoke where row.issuedAt == issuedAt && (0...500).contains(row.correctedAqi) {
            let seconds = row.validFor.timeIntervalSince(issuedAt)
            guard seconds >= 0, seconds.truncatingRemainder(dividingBy: 3600) == 0 else { continue }
            let lead = Int(seconds / 3600)
            guard lead <= Self.lastLead, byLead[lead] == nil else { continue }
            byLead[lead] = row
        }
        guard !byLead.isEmpty else { return nil }
        self.issuedAt = issuedAt
        slots = (0...Self.lastLead).map { lead in
            let row = byLead[lead]
            return Slot(
                lead: lead,
                validFor: issuedAt.addingTimeInterval(TimeInterval(lead) * 3600),
                aqi: row?.correctedAqi,
                pollutant: row?.pollutant
            )
        }
    }

    var missingLeads: [Int] { slots.filter { $0.aqi == nil }.map(\.lead) }

    /// The hour `date` falls in, or nil once the forecast has run out (past 48 hours) or before it starts.
    func lead(at date: Date) -> Int? {
        let seconds = date.timeIntervalSince(issuedAt)
        guard seconds >= 0 else { return nil }
        let lead = Int(seconds / 3600)
        return lead <= Self.lastLead ? lead : nil
    }

    /// The hours the user can drag through: from the current hour to the 48-hour lead. Earlier hours of
    /// the cycle are past and are not shown.
    func selectableLeads(now: Date) -> ClosedRange<Int>? {
        let seconds = now.timeIntervalSince(issuedAt)
        if seconds < 0 { return 0...Self.lastLead }
        return lead(at: now).map { $0...Self.lastLead }
    }
}
