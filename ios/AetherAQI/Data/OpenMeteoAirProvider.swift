import Foundation

/// Live air for internal TestFlight: Open-Meteo's air-quality API (CAMS model, keyless, CC BY 4.0) at the
/// place's pin. It fills the home number and the 48-hour timeline. It is a model, not a ground sensor, so there
/// is no AirNow reading. The best window, outlook and alerts still come from the sample provider until the
/// v1 API serves them to a signed-in app. No API keys are in the app.
struct OpenMeteoAirProvider: AirDataProvider {
    static let credit = "Live air: Open-Meteo.com (CAMS air quality model), CC BY 4.0. A model, not a ground monitor."

    /// The request. Tests pass recorded JSON instead.
    var fetch: @Sendable (URL) async throws -> Data = { url in
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw AirDataError.unavailable }
        return data
    }
    var now: @Sendable () -> Date = { Date() }
    /// Best window, outlook and alerts for this build.
    var sample = SampleAirProvider(delay: .zero)

    static func url(latitude: Double, longitude: Double) -> URL {
        var parts = URLComponents(string: "https://air-quality-api.open-meteo.com/v1/air-quality")!
        let fields = "us_aqi,us_aqi_pm2_5,us_aqi_ozone"
        parts.queryItems = [
            URLQueryItem(name: "latitude", value: String(latitude)),
            URLQueryItem(name: "longitude", value: String(longitude)),
            URLQueryItem(name: "current", value: fields),
            URLQueryItem(name: "hourly", value: fields),
            URLQueryItem(name: "forecast_days", value: "3"),
            URLQueryItem(name: "timeformat", value: "unixtime"),
            URLQueryItem(name: "timezone", value: "GMT"),
        ]
        return parts.url!
    }

    func homeSnapshot(for place: Place) async throws -> HomeSnapshot? {
        let reading = try await load(place)
        let hour = Self.hourStart(now())
        let current = reading.current.flatMap { c in c.usAqi.map { (aqi: $0, at: c.time, pollutant: Self.main(pm25: c.usAqiPm25, ozone: c.usAqiOzone)) } }
            ?? reading.hours.first { $0.time == hour }.flatMap { h in h.usAqi.map { (aqi: $0, at: h.time, pollutant: Self.main(pm25: h.usAqiPm25, ozone: h.usAqiOzone)) } }
        guard let current else { return nil }
        return HomeSnapshot(
            place: place,
            now: CorrectedForecast(aqi: Self.clamp(current.aqi), pollutant: current.pollutant, validFor: current.at, issuedAt: hour, confidence: .model),
            official: nil,
            credit: Self.credit
        )
    }

    /// Hours from the current one through 48 hours ahead, in the timeline's row shape.
    func hourlyForecast(for place: Place) async throws -> [ForecastHour] {
        let reading = try await load(place)
        let issuedAt = Self.hourStart(now())
        let last = issuedAt.addingTimeInterval(TimeInterval(ForecastTimeline.lastLead) * 3600)
        return reading.hours.compactMap { hour in
            guard hour.time >= issuedAt, hour.time <= last, let aqi = hour.usAqi else { return nil }
            return ForecastHour(
                id: "openmeteo_\(Int(hour.time.timeIntervalSince1970))", placeId: place.id, source: ForecastHour.smokeSource,
                issuedAt: issuedAt, validFor: hour.time, horizon: ForecastHour.valleyHorizon, spatialScale: "model",
                confidence: "model", correctedAqi: Self.clamp(aqi), pollutant: Self.main(pm25: hour.usAqiPm25, ozone: hour.usAqiOzone)
            )
        }
    }

    func bestWindow(for place: Place) async throws -> BestWindowResponse { try await sample.bestWindow(for: place) }
    func outlook(for place: Place) async throws -> OutlookResponse { try await sample.outlook(for: place) }
    func alerts(for place: Place) async throws -> AlertsResponse { try await sample.alerts(for: place) }

    private func load(_ place: Place) async throws -> OpenMeteoReading {
        guard let latitude = place.latitude, let longitude = place.longitude else { throw AirDataError.unavailable }
        return try OpenMeteoReading(data: try await fetch(Self.url(latitude: latitude, longitude: longitude)))
    }

    static func hourStart(_ date: Date) -> Date {
        Date(timeIntervalSince1970: (date.timeIntervalSince1970 / 3600).rounded(.down) * 3600)
    }

    /// The pollutant with the higher sub-index, as AirNow names it.
    static func main(pm25: Double?, ozone: Double?) -> String? {
        switch (pm25, ozone) {
        case let (p?, o?): o > p ? "Ozone" : "PM2.5"
        case (_?, nil): "PM2.5"
        case (nil, _?): "Ozone"
        case (nil, nil): nil
        }
    }

    static func clamp(_ aqi: Double) -> Int { min(500, max(0, Int(aqi.rounded()))) }
}

/// The parts of Open-Meteo's air-quality response the app reads (`timeformat=unixtime`).
struct OpenMeteoReading: Equatable, Sendable {
    struct Values: Equatable, Sendable {
        let time: Date
        let usAqi: Double?
        let usAqiPm25: Double?
        let usAqiOzone: Double?
    }

    let current: Values?
    let hours: [Values]

    private struct Body: Decodable {
        struct Current: Decodable {
            let time: Double
            let us_aqi: Double?
            let us_aqi_pm2_5: Double?
            let us_aqi_ozone: Double?
        }
        struct Hourly: Decodable {
            let time: [Double]
            let us_aqi: [Double?]
            let us_aqi_pm2_5: [Double?]?
            let us_aqi_ozone: [Double?]?
        }
        let current: Current?
        let hourly: Hourly
    }

    init(data: Data) throws {
        let body = try JSONDecoder().decode(Body.self, from: data)
        current = body.current.map {
            Values(time: Date(timeIntervalSince1970: $0.time), usAqi: $0.us_aqi, usAqiPm25: $0.us_aqi_pm2_5, usAqiOzone: $0.us_aqi_ozone)
        }
        let h = body.hourly
        hours = h.time.indices.map { i in
            func at(_ list: [Double?]?) -> Double? { list.flatMap { i < $0.count ? $0[i] : nil } }
            return Values(time: Date(timeIntervalSince1970: h.time[i]), usAqi: at(h.us_aqi), usAqiPm25: at(h.us_aqi_pm2_5), usAqiOzone: at(h.us_aqi_ozone))
        }
    }
}
