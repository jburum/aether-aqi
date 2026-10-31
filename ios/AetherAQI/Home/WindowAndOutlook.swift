import SwiftUI

/// "Best time outside": the next 48 hours' best run of our corrected forecast, in the place's local time.
/// The band swatch is decorative; every fact is also in the text and the VoiceOver label.
struct BestWindowLine: View {
    let model: HomeModel
    let soft: RGB
    @ScaledMetric(relativeTo: .subheadline) private var body15: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var small13: CGFloat = 13
    @ScaledMetric(relativeTo: .footnote) private var swatch: CGFloat = 10

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Best time outside")
                .font(AppFont.sans(small13, weight: 650))
                .foregroundStyle(soft.color)
                .accessibilityAddTraits(.isHeader)
            content
        }
    }

    @ViewBuilder private var content: some View {
        switch model.bestWindowState {
        case .loading:
            Text("Finding the best hours…")
                .font(AppFont.sans(body15, weight: 500))
                .foregroundStyle(soft.color)
        case .failed:
            VStack(alignment: .leading, spacing: 8) {
                Text("Couldn't load the best time outside.")
                    .font(AppFont.sans(body15, weight: 500))
                    .foregroundStyle(soft.color)
                OutlineButton(title: "Try again") { Task { await model.reloadWindowAndOutlook() } }
            }
        case .loaded(let display):
            switch display.state {
            case .none:
                // Calm, not an alarm: there is simply nothing forecast yet.
                Text("No forecast hours in the next 48 hours yet. Check back after the next update.")
                    .font(AppFont.sans(body15, weight: 500))
                    .foregroundStyle(soft.color)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel(display.accessibilityLabel)
            case .window(let span, let level, let peak, let sources):
                VStack(alignment: .leading, spacing: 3) {
                    Text(span)
                        .font(AppFont.sans(body15 + 2, weight: 650))
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Circle()
                            .fill(Theme.bar(level).color)
                            .overlay(Circle().strokeBorder(Color.white.opacity(0.7), lineWidth: 1))
                            .frame(width: swatch, height: swatch)
                            .accessibilityHidden(true)
                        Text("Peak \(peak), \(level.label)")
                            .font(AppFont.sans(small13, weight: 650))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text("Our forecast, from the \(sources)")
                        .font(AppFont.sans(small13, weight: 500))
                        .foregroundStyle(soft.color)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(display.accessibilityLabel)
            }
        }
    }
}

/// Tomorrow and this weekend: worst and typical corrected AQI per day. Days 1–2 are the valley forecast;
/// a day with any hour past 48 hours carries a visible "Regional and low-confidence" label and a dashed,
/// quieter card, so it never reads like the valley forecast.
struct OutlookSection: View {
    let model: HomeModel
    let soft: RGB
    @ScaledMetric(relativeTo: .footnote) private var small13: CGFloat = 13
    @ScaledMetric(relativeTo: .subheadline) private var body15: CGFloat = 15

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Outlook · our forecast")
                .font(AppFont.sans(small13, weight: 650))
                .foregroundStyle(soft.color)
                .accessibilityAddTraits(.isHeader)
            switch model.outlookState {
            case .loading:
                Text("Loading tomorrow and the weekend…")
                    .font(AppFont.sans(body15, weight: 500))
                    .foregroundStyle(soft.color)
            case .failed:
                VStack(alignment: .leading, spacing: 8) {
                    Text("Couldn't load the outlook.")
                        .font(AppFont.sans(body15, weight: 500))
                        .foregroundStyle(soft.color)
                    OutlineButton(title: "Try again") { Task { await model.reloadWindowAndOutlook() } }
                }
            case .loaded(let outlook):
                OutlookDayCard(day: outlook.tomorrow, title: "Tomorrow", soft: soft)
                Text("This weekend")
                    .font(AppFont.sans(small13, weight: 650))
                    .foregroundStyle(soft.color)
                    .padding(.top, 4)
                    .accessibilityAddTraits(.isHeader)
                OutlookDayCard(day: outlook.saturday, title: nil, soft: soft)
                OutlookDayCard(day: outlook.sunday, title: nil, soft: soft)
            }
        }
    }
}

private struct OutlookDayCard: View {
    let day: OutlookDayDisplay
    /// The card's heading; nil uses the day's own relation ("Today", "Sunday").
    let title: String?
    let soft: RGB
    @ScaledMetric(relativeTo: .subheadline) private var body15: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var small13: CGFloat = 13
    @ScaledMetric(relativeTo: .title2) private var number: CGFloat = 24
    @ScaledMetric(relativeTo: .footnote) private var swatch: CGFloat = 10

    private var valley: Bool {
        if case .summary(_, _, _, let valley) = day.state { valley } else { true }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) {
                    heading.fixedSize()
                    Spacer(minLength: 8)
                    dateLine.fixedSize()
                }
                VStack(alignment: .leading, spacing: 2) {
                    heading
                    dateLine
                }
            }
            switch day.state {
            case .noData:
                Text("No forecast for this day yet.")
                    .font(AppFont.sans(body15, weight: 500))
                    .foregroundStyle(soft.color)
                    .fixedSize(horizontal: false, vertical: true)
            case .summary(let worst, let typical, let level, let valley):
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Circle()
                        .fill(Theme.bar(level).color)
                        .overlay(Circle().strokeBorder(Color.white.opacity(0.7), lineWidth: 1))
                        .frame(width: swatch, height: swatch)
                        .accessibilityHidden(true)
                    Text(level.label)
                        .font(AppFont.sans(small13, weight: 650))
                        .fixedSize(horizontal: false, vertical: true)
                }
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 14) {
                        figure("Worst", worst, valley: valley)
                        figure("Typical", typical, valley: valley)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        figure("Worst", worst, valley: valley)
                        figure("Typical", typical, valley: valley)
                    }
                }
                confidence(valley: valley)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(valley ? 0.08 : 0.03), in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.white.opacity(valley ? 0.22 : 0.5), style: StrokeStyle(lineWidth: 1, dash: valley ? [] : [5, 4]))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title.map { "\($0). \(day.accessibilityLabel)" } ?? day.accessibilityLabel)
    }

    private var heading: some View {
        Text(title ?? day.relation)
            .font(AppFont.sans(body15, weight: 650))
    }

    private var dateLine: some View {
        Text(day.dateText)
            .font(AppFont.sans(small13, weight: 500))
            .foregroundStyle(soft.color)
    }

    private func figure(_ label: String, _ value: Int, valley: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(value, format: .number.grouping(.never))
                .font(AppFont.sans(number, weight: valley ? 700 : 560))
                .monospacedDigit()
            Text(label)
                .font(AppFont.sans(small13, weight: 500))
                .foregroundStyle(soft.color)
        }
    }

    /// Always visible. A low-confidence day says so in words, not only with the dashed card.
    private func confidence(valley: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: valley ? "mountain.2" : "exclamationmark.circle")
                .font(.system(size: small13 - 1, weight: .semibold))
                .accessibilityHidden(true)
            Text(valley ? "Valley forecast" : "Regional and low-confidence")
                .font(AppFont.sans(small13, weight: valley ? 500 : 650))
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(valley ? soft.color : Color.white)
    }
}
