import Foundation

struct AirQualityCurrent: Decodable {
    let time: String
    let us_aqi: Double?
    let pm2_5: Double?
    let pm10: Double?
    let ozone: Double?
    let nitrogen_dioxide: Double?
    let sulphur_dioxide: Double?
    let carbon_monoxide: Double?
}

struct AirQualityPayload: Decodable {
    let latitude: Double
    let longitude: Double
    let timezone: String?
    let current: AirQualityCurrent
    let error: String?
}

/// Calls the same /api/aqi proxy the PWA uses (which fronts Open-Meteo).
/// LICENSE FLAG: Open-Meteo free tier is non-commercial only. A paid App Store
/// release needs the commercial plan (~$29/mo, NOT approved) or another source.
/// Dev/simulator use only until that decision is made.
enum AQIService {
    static var baseURL = URL(string: "https://aether-aqi.vercel.app")!

    static func fetch(lat: Double, lon: Double) async throws -> AirQualityPayload {
        var c = URLComponents(url: baseURL.appendingPathComponent("api/aqi"), resolvingAgainstBaseURL: false)!
        c.queryItems = [.init(name: "lat", value: String(lat)), .init(name: "lon", value: String(lon))]
        var req = URLRequest(url: c.url!, timeoutInterval: 12)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { throw URLError(.badServerResponse) }
        let p = try JSONDecoder().decode(AirQualityPayload.self, from: data)
        if let e = p.error { throw NSError(domain: "AQI", code: 1, userInfo: [NSLocalizedDescriptionKey: e]) }
        return p
    }

    /// Mirrors primaryPollutant() in src/lib/open-meteo.ts.
    static func mainPollutant(_ c: AirQualityCurrent) -> String {
        if let pm = c.pm2_5, pm > 0 { return "PM2.5" }
        let e: [(String, Double?)] = [("PM10", c.pm10), ("O₃", c.ozone), ("NO₂", c.nitrogen_dioxide), ("SO₂", c.sulphur_dioxide), ("CO", c.carbon_monoxide)]
        return e.compactMap { n, v in v.map { (n, $0) } }.max { $0.1 < $1.1 }?.0 ?? "—"
    }
}
