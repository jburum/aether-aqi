import Foundation

/// The six EPA AQI categories. Colors come from the Round 5 field in design/round2-tokens.html:
/// one clear tint per level for the whole screen, white text at 4.5:1 or better, no purple.
enum AirLevel: String, CaseIterable, Sendable {
    case good, moderate, usg, unhealthy, very, hazardous

    /// EPA breakpoints: 0–50, 51–100, 101–150, 151–200, 201–300, 301 and up.
    init(aqi: Int) {
        switch aqi {
        case ..<51: self = .good
        case ..<101: self = .moderate
        case ..<151: self = .usg
        case ..<201: self = .unhealthy
        case ..<301: self = .very
        default: self = .hazardous
        }
    }

    var label: String {
        switch self {
        case .good: "Good"
        case .moderate: "Moderate"
        case .usg: "Unhealthy for Sensitive Groups"
        case .unhealthy: "Unhealthy"
        case .very: "Very Unhealthy"
        case .hazardous: "Hazardous"
        }
    }

    /// One advice line under the number (design/round2.html, CATS).
    var advice: String {
        switch self {
        case .good: "Clean enough for a long run."
        case .moderate: "Fine for most. Ease up if sensitive."
        case .usg: "Sensitive groups should cut time outside."
        case .unhealthy: "Everyone should limit time outside."
        case .very: "Stay indoors. The smoke is heavy."
        case .hazardous: "Emergency. Stay in with filtered air."
        }
    }

    /// The whole-screen tint (Round 5, LEVEL_TINT).
    var field: RGB {
        switch self {
        case .good: RGB(hex: 0x005129)
        case .moderate: RGB(hex: 0x463D00)
        case .usg: RGB(hex: 0x653400)
        case .unhealthy: RGB(hex: 0x791B0C)
        case .very: RGB(hex: 0x651818)
        case .hazardous: RGB(hex: 0x50171B)
        }
    }

    /// The number and pill word, fit to the settled field so the pill clears 4.5:1
    /// (levelAccent in design/round2.html, evaluated on each field).
    var accent: RGB {
        switch self {
        case .good: RGB(hex: 0x80DF94)
        case .moderate: RGB(hex: 0xAFCC57)
        case .usg: RGB(hex: 0xFCBB45)
        case .unhealthy: RGB(hex: 0xFFA683)
        case .very: RGB(hex: 0xF79B90)
        case .hazardous: RGB(hex: 0xE58B87)
        }
    }

    /// Secondary text: white softened toward the field until it still clears 4.7:1 (soften in round2.html).
    var softInk: RGB {
        switch self {
        case .good: RGB(hex: 0x9FBEAE)
        case .moderate: RGB(hex: 0xAFAC91)
        case .usg: RGB(hex: 0xC0AD97)
        case .unhealthy: RGB(hex: 0xC9A49E)
        case .very: RGB(hex: 0xBA9898)
        case .hazardous: RGB(hex: 0xA98E90)
        }
    }

    /// Where the dot sits on the spectrum bar. The bar's stops fall at AQI 0, 50, 100, 150, 200, 300
    /// and 500 at 0, 10, 20, 30, 40, 60 and 100 percent, which is AQI / 500.
    static func spectrumPosition(aqi: Int) -> Double {
        min(1, max(0, Double(aqi) / 500))
    }
}

/// An sRGB color as bytes, so the palette can be tested without a UI framework.
struct RGB: Equatable, Sendable {
    let r: UInt8, g: UInt8, b: UInt8

    init(hex: UInt32) {
        r = UInt8((hex >> 16) & 0xFF)
        g = UInt8((hex >> 8) & 0xFF)
        b = UInt8(hex & 0xFF)
    }

    init(r: UInt8, g: UInt8, b: UInt8) {
        self.r = r
        self.g = g
        self.b = b
    }

    static let white = RGB(hex: 0xFFFFFF)

    /// WCAG relative luminance.
    var luminance: Double {
        func channel(_ v: UInt8) -> Double {
            let c = Double(v) / 255
            return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }

    func contrast(with other: RGB) -> Double {
        let (a, b) = (luminance, other.luminance)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    /// `other` laid over this color at `alpha`.
    func overlaid(with other: RGB, alpha: Double) -> RGB {
        func mix(_ base: UInt8, _ top: UInt8) -> UInt8 {
            UInt8((Double(base) * (1 - alpha) + Double(top) * alpha).rounded())
        }
        return RGB(r: mix(r, other.r), g: mix(g, other.g), b: mix(b, other.b))
    }

    /// Hue in degrees (HSL), for the no-purple check.
    var hue: Double {
        let (rf, gf, bf) = (Double(r) / 255, Double(g) / 255, Double(b) / 255)
        let hi = max(rf, gf, bf), lo = min(rf, gf, bf), d = hi - lo
        guard d > 0 else { return 0 }
        var h: Double
        if hi == rf { h = (gf - bf) / d } else if hi == gf { h = (bf - rf) / d + 2 } else { h = (rf - gf) / d + 4 }
        h *= 60
        return h < 0 ? h + 360 : h
    }
}
