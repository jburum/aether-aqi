import CoreText
import SwiftUI

extension RGB {
    var color: Color { Color(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255) }
}

/// Tokens from design/tokens.css and the Round 5 field in design/round2-tokens.html.
enum Theme {
    /// The field before there is a level to show (loading, empty, error): --dark-bg.
    static let neutralField = RGB(hex: 0x121212)
    /// --dark-secondary, which clears 4.5:1 on the neutral field.
    static let neutralSoft = RGB(hex: 0xC8C8C8)
    static let ink = Color.white
    /// .level-pill: white at 8% over the field.
    static let pillFill = Color.white.opacity(0.08)
    /// The spectrum bar (round2.html .spectrum-bar). Green to maroon, no purple.
    static let spectrum: [Gradient.Stop] = [
        .init(color: RGB(hex: 0x3CA366).color, location: 0),
        .init(color: RGB(hex: 0x51A957).color, location: 0.1),
        .init(color: RGB(hex: 0xC4AB11).color, location: 0.2),
        .init(color: RGB(hex: 0xD77D20).color, location: 0.3),
        .init(color: RGB(hex: 0xC84531).color, location: 0.4),
        .init(color: RGB(hex: 0x972E2C).color, location: 0.6),
        .init(color: RGB(hex: 0x6E282A).color, location: 1),
    ]
    /// The field crossfade (round2.html: 600ms linear).
    static let fieldFade = Animation.linear(duration: 0.6)
}

/// Source Serif 4 and Source Sans 3, from design/fonts, unwrapped from WOFF2 to TrueType (both OFL).
/// They are variable fonts, so the weight is set on the `wght` axis.
enum AppFont {
    static let serifName = "SourceSerif4Roman-Regular"
    static let sansName = "SourceSans3-Roman"
    static let files = ["SourceSerif4-Latin", "SourceSans3-Latin"]

    /// Registers the bundled fonts for this process. Safe to call more than once.
    static func register(bundle: Bundle = .main) {
        for name in files {
            guard let url = bundle.url(forResource: name, withExtension: "ttf") else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }

    static func serif(_ size: CGFloat, weight: CGFloat) -> Font {
        // opsz 60 at display sizes, as in round2.html's .digits.
        variable(serifName, size: size, axes: ["wght": weight, "opsz": size >= 60 ? 60 : 32])
            ?? .system(size: size, weight: .heavy, design: .serif)
    }

    static func sans(_ size: CGFloat, weight: CGFloat) -> Font {
        variable(sansName, size: size, axes: ["wght": weight])
            ?? .system(size: size, weight: weight >= 600 ? .semibold : .regular)
    }

    private static func variable(_ postScriptName: String, size: CGFloat, axes: [String: CGFloat]) -> Font? {
        var variations: [NSNumber: CGFloat] = [:]
        for (tag, value) in axes { variations[NSNumber(value: fourCharCode(tag))] = value }
        let attributes: [CFString: Any] = [
            kCTFontNameAttribute: postScriptName,
            kCTFontVariationAttribute: variations,
        ]
        let descriptor = CTFontDescriptorCreateWithAttributes(attributes as CFDictionary)
        let font = CTFontCreateWithFontDescriptor(descriptor, size, nil)
        // CoreText falls back to another face when the name is not registered. A variation renames the
        // face (SourceSerif4Roman-ExtraBold), so match the family. Source Sans 3's subset reports its
        // family as "Source Sans 3 ExtraLight".
        let family = CTFontCopyFamilyName(font) as String
        guard family.hasPrefix(postScriptName == serifName ? "Source Serif 4" : "Source Sans 3") else { return nil }
        return Font(font)
    }

    private static func fourCharCode(_ tag: String) -> UInt32 {
        tag.utf8.reduce(0) { ($0 << 8) | UInt32($1) }
    }
}
