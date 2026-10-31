import SwiftUI

/// The Free home screen. The level of our corrected number tints the whole screen; loading, empty
/// and error use the neutral dark field, so no color ever stands for a number that is not shown.
struct HomeScreen: View {
    @State var model: HomeModel
    /// False only where the caller has already loaded the model (still renders of a fixed state).
    var loadsOnAppear = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let level = model.level
        ZStack {
            (level?.field ?? Theme.neutralField).color
                .ignoresSafeArea()
            // Scrolls once Dynamic Type makes the content taller than the screen; until then it fills
            // the screen, so the AirNow panel sits at the bottom and the states stay centered.
            GeometryReader { viewport in
                ScrollView(.vertical) {
                    VStack(alignment: .leading, spacing: 0) {
                        AppTitle(soft: level?.softInk ?? Theme.neutralSoft)
                        content
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 8)
                    .padding(.bottom, 12)
                    .frame(minHeight: viewport.size.height, alignment: .top)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .foregroundStyle(Theme.ink)
        .animation(reduceMotion ? nil : Theme.fieldFade, value: level)
        .preferredColorScheme(.dark)
        .task {
            if loadsOnAppear { await model.load() }
        }
    }

    @ViewBuilder private var content: some View {
        switch model.state {
        case .loading:
            LoadingState()
        case .loaded(let snapshot):
            CurrentAir(model: model, snapshot: snapshot)
        case .empty:
            EmptyState()
        case .failed:
            ErrorState { Task { await model.load() } }
        }
    }
}

/// Placeholder app name from the mockups; the real name is still open (docs/appstore/ROADMAP.md).
private struct AppTitle: View {
    let soft: RGB
    @ScaledMetric(relativeTo: .footnote) private var size: CGFloat = 13

    var body: some View {
        Text("Air Quality Forecast")
            .font(AppFont.sans(size, weight: 650))
            .foregroundStyle(soft.color)
            .frame(minHeight: 28, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Loaded

/// What the hero shows: the hour selected on the timeline, or the current number until the timeline is in.
struct HeroDisplay: Equatable {
    let kicker: String
    /// Nil when NOAA has no value for the selected hour.
    let aqi: Int?
    let pollutant: String?

    var level: AirLevel? { aqi.map(AirLevel.init(aqi:)) }
    var advice: String { level?.advice ?? "NOAA has no value for this hour." }

    @MainActor
    init(model: HomeModel, snapshot: HomeSnapshot) {
        switch model.selection {
        case .forecast(let slot, let isNow):
            kicker = Self.kicker(slot.validFor, isNow: isNow, place: snapshot.place)
            aqi = slot.aqi
            pollutant = slot.pollutant
        case .missing(let slot, let isNow):
            kicker = Self.kicker(slot.validFor, isNow: isNow, place: snapshot.place)
            aqi = nil
            pollutant = nil
        case nil:
            kicker = "Our forecast now"
            aqi = snapshot.now.aqi
            pollutant = snapshot.now.pollutant
        }
    }

    /// Every hour on the timeline is our forecast, so the label says so for each one.
    static func kicker(_ date: Date, isNow: Bool, place: Place) -> String {
        isNow ? "Our forecast now" : "Our forecast for \(HourLabel.dayAndHour(date, in: place.timeZone))"
    }
}

private struct CurrentAir: View {
    let model: HomeModel
    let snapshot: HomeSnapshot
    @ScaledMetric(relativeTo: .subheadline) private var body15: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var small13: CGFloat = 13
    @ScaledMetric(relativeTo: .largeTitle) private var hero: CGFloat = 120

    /// The level the field shows. It can lag the hero while a finger is on the timeline.
    private var fieldLevel: AirLevel? { model.level }
    private var soft: RGB { fieldLevel?.softInk ?? Theme.neutralSoft }

    var body: some View {
        let display = HeroDisplay(model: model, snapshot: snapshot)
        // Each accent is fit to its own field. While the field holds during a drag, the hero switches
        // to white, which clears 4.5:1 on every field.
        let accent = display.level != nil && display.level == fieldLevel ? display.level!.accent : RGB.white
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(snapshot.place.name)
                    .font(AppFont.sans(body15, weight: 650))
                Text(snapshot.place.region)
                    .font(AppFont.sans(body15, weight: 500))
                    .foregroundStyle(soft.color)
            }
            .padding(.top, 6)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(snapshot.place.name), \(snapshot.place.region)")

            VStack(alignment: .leading, spacing: 0) {
                Text(display.kicker)
                    .font(AppFont.sans(small13, weight: 650))
                    .foregroundStyle(soft.color)
                    .padding(.top, 22)

                Group {
                    if let aqi = display.aqi {
                        Text(aqi, format: .number.grouping(.never))
                            .contentTransition(.numericText(value: Double(aqi)))
                    } else {
                        Text("–")
                    }
                }
                .font(AppFont.serif(min(hero, 160), weight: 800))
                .monospacedDigit()
                .foregroundStyle(accent.color)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                // Source Serif's ascent leaves a tall gap above the digits at this size.
                .padding(.top, -16)

                // Side by side when they fit; otherwise the pollutant drops under the pill, and the
                // pill's words wrap rather than truncate ("Unhealthy for Sensitive Groups"). An hour with
                // no forecast keeps the row, so the timeline does not jump under the finger.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        levelPill(display.level?.label ?? "No forecast", accent: accent).fixedSize()
                        pollutantText(display.pollutant)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        levelPill(display.level?.label ?? "No forecast", accent: accent)
                        pollutantText(display.pollutant)
                    }
                }
                .padding(.top, 4)

                Text(display.advice)
                    .font(AppFont.sans(body15, weight: 560))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 6)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(heroLabel(display))

            SpectrumBar(aqi: display.aqi)
                .padding(.top, 12)

            TimelineSection(model: model, place: snapshot.place, soft: soft)
                .padding(.top, 18)

            BestWindowLine(window: snapshot.bestWindow, place: snapshot.place, soft: soft)
                .padding(.top, 18)

            Spacer(minLength: 16)

            OfficialCard(reading: snapshot.official, place: snapshot.place, soft: soft)
        }
    }

    private func levelPill(_ label: String, accent: RGB) -> some View {
        Text(label)
            .font(AppFont.sans(small13, weight: 650))
            .foregroundStyle(accent.color)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10)
            .padding(.vertical, 3)
            .frame(minHeight: 26)
            .background(Theme.pillFill, in: RoundedRectangle(cornerRadius: 13))
    }

    @ViewBuilder private func pollutantText(_ pollutant: String?) -> some View {
        if let pollutant {
            Text(pollutant)
                .font(AppFont.sans(small13, weight: 650))
                .foregroundStyle(soft.color)
        }
    }

    private func heroLabel(_ display: HeroDisplay) -> String {
        guard let aqi = display.aqi, let level = display.level else {
            return "\(display.kicker): no forecast for this hour."
        }
        var parts = ["\(display.kicker): air quality index \(aqi), \(level.label)"]
        if let pollutant = display.pollutant { parts.append("Main pollutant \(pollutant)") }
        parts.append(level.advice)
        return parts.joined(separator: ". ")
    }
}

/// Green to maroon with a dot on the current value (round2.html .spectrum). No value, no dot.
private struct SpectrumBar: View {
    let aqi: Int?

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(LinearGradient(stops: Theme.spectrum, startPoint: .leading, endPoint: .trailing))
                    .frame(height: 10)
                if let aqi {
                    let x = geo.size.width * AirLevel.spectrumPosition(aqi: aqi)
                    Circle()
                        .fill(Color.white)
                        .overlay(Circle().strokeBorder(RGB(hex: 0x1A120C).color, lineWidth: 1.5))
                        .frame(width: 16, height: 16)
                        .offset(x: min(max(x - 8, 0), geo.size.width - 16))
                }
            }
            .frame(maxHeight: .infinity)
        }
        .frame(height: 22)
        .accessibilityHidden(true)
    }
}

/// Phase 0 placeholder. The best-window logic lands in Phase 2 (v1-plan.md).
private struct BestWindowLine: View {
    let window: BestWindow?
    let place: Place
    let soft: RGB
    @ScaledMetric(relativeTo: .subheadline) private var body15: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var small13: CGFloat = 13

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Best time outside")
                .font(AppFont.sans(small13, weight: 650))
                .foregroundStyle(soft.color)
            if let window {
                Text(span(window))
                    .font(AppFont.sans(body15, weight: 650))
            } else {
                Text("Not ready yet")
                    .font(AppFont.sans(body15, weight: 560))
                    .foregroundStyle(soft.color)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func span(_ window: BestWindow) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .shortened)
        style.timeZone = place.timeZone
        return "\(window.start.formatted(style)) to \(window.end.formatted(style))"
    }
}

/// The official AirNow number, unaltered, marked preliminary and credited. Kept apart from our
/// forecast: its own panel, plain sans digits and white ink instead of the level color.
private struct OfficialCard: View {
    let reading: OfficialReading?
    let place: Place
    let soft: RGB
    @ScaledMetric(relativeTo: .subheadline) private var body15: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var small13: CGFloat = 13
    @ScaledMetric(relativeTo: .caption) private var tiny12: CGFloat = 12
    @ScaledMetric(relativeTo: .title) private var number: CGFloat = 30

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // The Preliminary tag drops under the title when both don't fit on one line.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    title.fixedSize()
                    Spacer(minLength: 0)
                    preliminaryTag
                }
                VStack(alignment: .leading, spacing: 6) {
                    title
                    preliminaryTag
                }
            }
            if let reading {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(reading.aqi, format: .number.grouping(.never))
                        .font(AppFont.sans(number, weight: 650))
                        .monospacedDigit()
                    Text("AQI · observed \(observed(reading))")
                        .font(AppFont.sans(body15, weight: 500))
                        .foregroundStyle(soft.color)
                }
                Text(reading.attribution)
                    .font(AppFont.sans(tiny12, weight: 500))
                    .foregroundStyle(soft.color)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("No AirNow monitor has reported near this place.")
                    .font(AppFont.sans(body15, weight: 500))
                    .foregroundStyle(soft.color)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black.opacity(0.28), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.white.opacity(0.22), lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var title: some View {
        Text("Official AirNow reading")
            .font(AppFont.sans(small13, weight: 650))
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private var preliminaryTag: some View {
        if reading != nil {
            Text("Preliminary")
                .font(AppFont.sans(tiny12, weight: 650))
                .fixedSize()
                .padding(.horizontal, 8)
                .frame(minHeight: 22)
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.6), lineWidth: 1))
        }
    }

    private func observed(_ reading: OfficialReading) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .shortened)
        style.timeZone = place.timeZone
        return reading.observedAt.formatted(style)
    }

    private var accessibilityText: String {
        guard let reading else { return "Official AirNow reading: none near this place." }
        return "Official AirNow reading, preliminary: air quality index \(reading.aqi), observed \(observed(reading)). \(reading.attribution)"
    }
}

// MARK: - Loading, empty, error

private struct LoadingState: View {
    @ScaledMetric(relativeTo: .subheadline) private var body15: CGFloat = 15

    var body: some View {
        VStack(spacing: 14) {
            ProgressView()
                .tint(.white)
                .controlSize(.large)
            Text("Loading the air")
                .font(AppFont.sans(body15, weight: 560))
                .foregroundStyle(Theme.neutralSoft.color)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

private struct StateMessage<Action: View>: View {
    let symbol: String
    let title: String
    let message: String
    @ViewBuilder var action: Action
    @ScaledMetric(relativeTo: .title) private var titleSize: CGFloat = 26
    @ScaledMetric(relativeTo: .subheadline) private var body15: CGFloat = 15

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Spacer()
            Image(systemName: symbol)
                .font(.system(size: 30, weight: .regular))
                .foregroundStyle(Theme.neutralSoft.color)
                .accessibilityHidden(true)
            Text(title)
                .font(AppFont.serif(titleSize, weight: 560))
                .accessibilityAddTraits(.isHeader)
            Text(message)
                .font(AppFont.sans(body15, weight: 500))
                .foregroundStyle(Theme.neutralSoft.color)
                .fixedSize(horizontal: false, vertical: true)
            action
                .padding(.top, 6)
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct EmptyState: View {
    var body: some View {
        StateMessage(
            symbol: "mappin.and.ellipse",
            title: "No place yet",
            message: "Add a place to see its air right now and the best time to be outside."
        ) {
            EmptyView()
        }
    }
}

private struct ErrorState: View {
    let retry: () -> Void

    var body: some View {
        StateMessage(
            symbol: "exclamationmark.triangle",
            title: "Can't load the air",
            message: "Check your connection and try again. We won't show an old number as if it were current."
        ) {
            OutlineButton(title: "Try again", action: retry)
        }
    }
}

/// White-outlined capsule button, at least 44 points tall.
struct OutlineButton: View {
    let title: String
    let action: () -> Void
    @ScaledMetric(relativeTo: .body) private var body17: CGFloat = 17

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(AppFont.sans(body17, weight: 650))
                .multilineTextAlignment(.leading)
                .padding(.horizontal, 18)
                .padding(.vertical, 8)
                .frame(minHeight: 44)
                .overlay(Capsule().strokeBorder(Color.white, lineWidth: 1.5))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}
