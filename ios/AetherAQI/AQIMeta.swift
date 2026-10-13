import SwiftUI

/// Mirrors src/lib/aqi.ts (US EPA AQI bands).
struct AQIMeta {
    let label: String
    let advice: String
    let color: Color

    static func of(_ aqi: Double?) -> AQIMeta {
        guard let v = aqi, v >= 0 else { return .init(label: "—", advice: "No reading yet.", color: Color(hex: 0x5c6570)) }
        switch v {
        case ...50: return .init(label: "Good", advice: "Air quality is satisfactory. Great day for outdoor activity.", color: Color(hex: 0x3dba6e))
        case ...100: return .init(label: "Moderate", advice: "Acceptable overall. Unusually sensitive people should limit prolonged outdoor exertion.", color: Color(hex: 0xd4b106))
        case ...150: return .init(label: "Unhealthy for Sensitive Groups", advice: "Sensitive groups should reduce prolonged or heavy outdoor exertion.", color: Color(hex: 0xe07a1f))
        case ...200: return .init(label: "Unhealthy", advice: "Everyone may begin to feel effects. Limit outdoor activity.", color: Color(hex: 0xe23d3d))
        case ...300: return .init(label: "Very Unhealthy", advice: "Health alert: avoid outdoor exertion. Consider masks for PM2.5.", color: Color(hex: 0x9b5de5))
        default: return .init(label: "Hazardous", advice: "Emergency conditions. Remain indoors with filtered air if possible.", color: Color(hex: 0x7f1d1d))
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255, blue: Double(hex & 0xff) / 255)
    }
}
