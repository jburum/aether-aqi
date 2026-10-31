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
            VStack(alignment: .leading, spacing: 0) {
                AppTitle(soft: level?.softInk ?? Theme.neutralSoft)
                content
            }
            .padding(.horizontal, 18)
            .padding(.top, 8)
            .padding(.bottom, 12)
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
            CurrentAir(snapshot: snapshot)
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

private struct CurrentAir: View {
    let snapshot: HomeSnapshot
    @ScaledMetric(relativeTo: .subheadline) private var body15: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var small13: CGFloat = 13
    @ScaledMetric(relativeTo: .largeTitle) private var hero: CGFloat = 120

    private var level: AirLevel { snapshot.now.level }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(snapshot.place.name)
                    .font(AppFont.sans(body15, weight: 650))
                Text(snapshot.place.region)
                    .font(AppFont.sans(body15, weight: 500))
                    .foregroundStyle(level.softInk.color)
            }
            .padding(.top, 6)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(snapshot.place.name), \(snapshot.place.region)")

            VStack(alignment: .leading, spacing: 0) {
                Text("Our forecast now")
                    .font(AppFont.sans(small13, weight: 650))
                    .foregroundStyle(level.softInk.color)
                    .padding(.top, 22)

                Text(snapshot.now.aqi, format: .number.grouping(.never))
                    .font(AppFont.serif(min(hero, 160), weight: 800))
                    .monospacedDigit()
                    .foregroundStyle(level.accent.color)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                    .contentTransition(.numericText(value: Double(snapshot.now.aqi)))
                    // Source Serif's ascent leaves a tall gap above the digits at this size.
                    .padding(.top, -16)

                HStack(spacing: 10) {
                    Text(level.label)
                        .font(AppFont.sans(small13, weight: 650))
                        .foregroundStyle(level.accent.color)
                        .lineLimit(1)
                        .padding(.horizontal, 10)
                        .frame(minHeight: 26)
                        .background(Theme.pillFill, in: Capsule())
                    if let pollutant = snapshot.now.pollutant {
                        Text(pollutant)
                            .font(AppFont.sans(small13, weight: 650))
                            .foregroundStyle(level.softInk.color)
                    }
                }
                .padding(.top, 4)

                Text(level.advice)
                    .font(AppFont.sans(body15, weight: 560))
                    .padding(.top, 6)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(heroLabel)

            SpectrumBar(aqi: snapshot.now.aqi)
                .padding(.top, 12)

            BestWindowLine(window: snapshot.bestWindow, place: snapshot.place, soft: level.softInk)
                .padding(.top, 20)

            Spacer(minLength: 16)

            OfficialCard(reading: snapshot.official, place: snapshot.place, soft: level.softInk)
        }
    }

    private var heroLabel: String {
        var parts = ["Our forecast now: air quality index \(snapshot.now.aqi), \(level.label)"]
        if let pollutant = snapshot.now.pollutant { parts.append("Main pollutant \(pollutant)") }
        parts.append(level.advice)
        return parts.joined(separator: ". ")
    }
}

/// Green to maroon with a dot on the current value (round2.html .spectrum).
private struct SpectrumBar: View {
    let aqi: Int

    var body: some View {
        GeometryReader { geo in
            let x = geo.size.width * AirLevel.spectrumPosition(aqi: aqi)
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(LinearGradient(stops: Theme.spectrum, startPoint: .leading, endPoint: .trailing))
                    .frame(height: 10)
                Circle()
                    .fill(Color.white)
                    .overlay(Circle().strokeBorder(RGB(hex: 0x1A120C).color, lineWidth: 1.5))
                    .frame(width: 16, height: 16)
                    .offset(x: min(max(x - 8, 0), geo.size.width - 16))
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
            HStack(spacing: 8) {
                Text("Official AirNow reading")
                    .font(AppFont.sans(small13, weight: 650))
                Spacer(minLength: 0)
                if reading != nil {
                    Text("Preliminary")
                        .font(AppFont.sans(tiny12, weight: 650))
                        .padding(.horizontal, 8)
                        .frame(minHeight: 22)
                        .overlay(Capsule().strokeBorder(Color.white.opacity(0.6), lineWidth: 1))
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
    @ScaledMetric(relativeTo: .body) private var body17: CGFloat = 17

    var body: some View {
        StateMessage(
            symbol: "exclamationmark.triangle",
            title: "Can't load the air",
            message: "Check your connection and try again. We won't show an old number as if it were current."
        ) {
            Button(action: retry) {
                Text("Try again")
                    .font(AppFont.sans(body17, weight: 650))
                    .padding(.horizontal, 18)
                    .frame(minHeight: 44)
                    .overlay(Capsule().strokeBorder(Color.white, lineWidth: 1.5))
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
        }
    }
}
