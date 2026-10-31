import Testing
@testable import AetherAQI

@Suite("Air levels and palette")
struct AirLevelTests {
    @Test("EPA breakpoints", arguments: [
        (0, AirLevel.good), (50, .good), (51, .moderate), (100, .moderate), (101, .usg), (150, .usg),
        (151, .unhealthy), (200, .unhealthy), (201, .very), (300, .very), (301, .hazardous), (500, .hazardous), (999, .hazardous),
    ])
    func breakpoints(aqi: Int, level: AirLevel) {
        #expect(AirLevel(aqi: aqi) == level)
    }

    @Test("White text clears 4.5:1 on every field")
    func whiteOnField() {
        for level in AirLevel.allCases {
            #expect(RGB.white.contrast(with: level.field) >= 4.5, "\(level)")
        }
    }

    @Test("The level word clears 4.5:1 on its pill (white at 8% over the field)")
    func accentOnPill() {
        for level in AirLevel.allCases {
            let pill = level.field.overlaid(with: .white, alpha: 0.08)
            #expect(level.accent.contrast(with: pill) >= 4.5, "\(level)")
        }
    }

    @Test("Secondary text clears 4.5:1 on the field and on the neutral field")
    func softInk() {
        for level in AirLevel.allCases {
            #expect(level.softInk.contrast(with: level.field) >= 4.5, "\(level)")
        }
        #expect(Theme.neutralSoft.contrast(with: Theme.neutralField) >= 4.5)
    }

    @Test("No purple: no field, accent or soft ink has a hue in 250–345°")
    func noPurple() {
        for level in AirLevel.allCases {
            for color in [level.field, level.accent, level.softInk] {
                #expect(!(250...345).contains(color.hue), "\(level) \(color)")
            }
        }
    }

    @Test("The spectrum dot tracks AQI / 500 and stays on the bar")
    func spectrum() {
        #expect(AirLevel.spectrumPosition(aqi: 0) == 0)
        #expect(AirLevel.spectrumPosition(aqi: 50) == 0.1)
        #expect(AirLevel.spectrumPosition(aqi: 200) == 0.4)
        #expect(AirLevel.spectrumPosition(aqi: 300) == 0.6)
        #expect(AirLevel.spectrumPosition(aqi: 750) == 1)
        #expect(AirLevel.spectrumPosition(aqi: -5) == 0)
    }
}
