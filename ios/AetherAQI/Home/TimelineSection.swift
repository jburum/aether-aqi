import SwiftUI

/// Hour labels in the place's time zone: "3 PM", or "Sun 3 PM" when it is not the same day as `relativeTo`.
enum HourLabel {
    static func hour(_ date: Date, in zone: TimeZone) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .omitted).hour(.defaultDigits(amPM: .abbreviated))
        style.timeZone = zone
        return date.formatted(style)
    }

    static func dayAndHour(_ date: Date, in zone: TimeZone) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .omitted).weekday(.abbreviated).hour(.defaultDigits(amPM: .abbreviated))
        style.timeZone = zone
        return date.formatted(style)
    }

    static func axis(_ date: Date, in zone: TimeZone, relativeTo reference: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.isDate(date, inSameDayAs: reference) ? hour(date, in: zone) : dayAndHour(date, in: zone)
    }
}

/// The 48-hour drag timeline: one bar per hour of our forecast, from now to the 48-hour lead.
/// Dragging moves the hero to that hour; the field follows on release. VoiceOver adjusts it by an hour.
struct TimelineSection: View {
    let model: HomeModel
    let place: Place
    let soft: RGB
    @ScaledMetric(relativeTo: .footnote) private var small13: CGFloat = 13
    @ScaledMetric(relativeTo: .caption) private var tiny12: CGFloat = 12
    @ScaledMetric(relativeTo: .subheadline) private var body15: CGFloat = 15

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) {
                    title.fixedSize()
                    Spacer(minLength: 8)
                    nowButton
                }
                VStack(alignment: .leading, spacing: 6) {
                    title
                    nowButton
                }
            }
            content
        }
    }

    private var title: some View {
        Text("Next 48 hours · our forecast")
            .font(AppFont.sans(small13, weight: 650))
            .foregroundStyle(soft.color)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder private var nowButton: some View {
        if let nowLead = model.nowLead, model.timeline != nil, model.selectedLead != nowLead {
            Button("Back to now") { model.selectNow() }
                .font(AppFont.sans(small13, weight: 650))
                .buttonStyle(.plain)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
    }

    @ViewBuilder private var content: some View {
        switch model.timelineState {
        case .loading:
            VStack(alignment: .leading, spacing: 8) {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.white.opacity(0.08))
                    .frame(height: TimelineChart.height)
                message("Loading the hourly forecast")
            }
            .accessibilityElement(children: .combine)
        case .empty:
            message("No hourly forecast for this place yet.")
        case .outdated:
            VStack(alignment: .leading, spacing: 8) {
                message("The hourly forecast is out of date, so it is hidden.")
                OutlineButton(title: "Try again") { Task { await model.reloadTimeline() } }
            }
        case .failed:
            VStack(alignment: .leading, spacing: 8) {
                message("Couldn't load the hourly forecast.")
                OutlineButton(title: "Try again") { Task { await model.reloadTimeline() } }
            }
        case .loaded(let timeline):
            if let range = model.selectableLeads {
                VStack(alignment: .leading, spacing: 6) {
                    TimelineChart(model: model, timeline: timeline, range: range, place: place)
                    AxisLabels(timeline: timeline, range: range, place: place, soft: soft)
                    Text(caption(timeline))
                        .font(AppFont.sans(tiny12, weight: 500))
                        .foregroundStyle(soft.color)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(AppFont.sans(body15, weight: 500))
            .foregroundStyle(soft.color)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func caption(_ timeline: ForecastTimeline) -> String {
        let issued = HourLabel.dayAndHour(timeline.issuedAt, in: place.timeZone)
        var text = "NOAA smoke model, corrected for the valley. Issued \(issued)."
        if model.selectableLeads.map({ range in timeline.missingLeads.contains(where: range.contains) }) == true {
            text += " Gaps are hours with no forecast."
        }
        return text
    }
}

/// The bars, the selected-hour marker and the drag and VoiceOver handling.
private struct TimelineChart: View {
    static let height: CGFloat = 72
    /// Bars reach full height at this AQI; higher values are capped at the top.
    static let topAqi = 300.0

    let model: HomeModel
    let timeline: ForecastTimeline
    let range: ClosedRange<Int>
    let place: Place

    var body: some View {
        GeometryReader { geo in
            let slots = Array(timeline.slots[range])
            let step = geo.size.width / CGFloat(slots.count)
            Canvas { context, size in
                for (index, slot) in slots.enumerated() {
                    let x = CGFloat(index) * step
                    let barWidth = max(1, step - 1.5)
                    if let aqi = slot.aqi, let level = slot.level {
                        let h = max(3, size.height * min(1, Double(aqi) / Self.topAqi))
                        let rect = CGRect(x: x, y: size.height - h, width: barWidth, height: h)
                        context.fill(Path(roundedRect: rect, cornerRadius: min(2, barWidth / 2)), with: .color(Theme.bar(level).color))
                    } else {
                        // No value for this hour: a hollow stub on the baseline, not a bar of zero.
                        let rect = CGRect(x: x + 0.5, y: size.height - 6, width: max(1, barWidth - 1), height: 5.5)
                        context.stroke(Path(rect), with: .color(.white.opacity(0.55)), style: StrokeStyle(lineWidth: 1, dash: [2, 1.5]))
                    }
                }
                let selectedIndex = model.selectedLead - range.lowerBound
                let marker = CGRect(x: CGFloat(selectedIndex) * step + (step - 1.5) / 2 - 1, y: 0, width: 2, height: size.height)
                context.fill(Path(marker), with: .color(.white))
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        if !model.isScrubbing { model.beginScrub() }
                        let index = Int((value.location.x / max(step, 1)).rounded(.down))
                        model.select(lead: range.lowerBound + index)
                    }
                    .onEnded { _ in model.endScrub() }
            )
        }
        .frame(height: Self.height)
        .sensoryFeedback(.selection, trigger: model.selectedLead)
        .accessibilityElement()
        .accessibilityLabel("48-hour forecast")
        .accessibilityValue(accessibilityValue)
        .accessibilityHint("Swipe up or down to move one hour.")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: model.step(by: 1)
            case .decrement: model.step(by: -1)
            @unknown default: break
            }
        }
    }

    private var accessibilityValue: String {
        let slot = timeline.slots[model.selectedLead]
        let when = model.selectedLead == model.nowLead ? "Now, \(HourLabel.dayAndHour(slot.validFor, in: place.timeZone))" : HourLabel.dayAndHour(slot.validFor, in: place.timeZone)
        guard let aqi = slot.aqi, let level = slot.level else { return "\(when), no forecast for this hour" }
        return "\(when), forecast air quality index \(aqi), \(level.label)"
    }
}

/// Hour labels under the chart, each under its own bar: the two ends pinned to the edges, the ones
/// between centered on their hour. Fewer labels at larger text sizes.
private struct AxisLabels: View {
    let timeline: ForecastTimeline
    let range: ClosedRange<Int>
    let place: Place
    let soft: RGB
    @ScaledMetric(relativeTo: .caption) private var tiny12: CGFloat = 12
    @Environment(\.dynamicTypeSize) private var typeSize

    /// About one label per 85 points of width at the default size, fewer as text grows.
    private func count(width: CGFloat) -> Int {
        let byType = typeSize.isAccessibilitySize ? 2 : typeSize > .large ? 3 : 4
        return max(2, min(byType, Int(width / 85)))
    }

    var body: some View {
        GeometryReader { geo in
            let count = count(width: geo.size.width)
            let leads = (0..<count).map { k in
                range.lowerBound + Int((Double(k) * Double(range.count - 1) / Double(count - 1)).rounded())
            }
            let step = geo.size.width / CGFloat(range.count)
            ZStack(alignment: .topLeading) {
                ForEach(Array(leads.enumerated()), id: \.offset) { index, lead in
                    let text = Text(label(lead)).fixedSize()
                    if index == 0 {
                        text.frame(maxWidth: .infinity, alignment: .leading)
                    } else if index == leads.count - 1 {
                        text.frame(maxWidth: .infinity, alignment: .trailing)
                    } else {
                        text.position(x: (CGFloat(lead - range.lowerBound) + 0.5) * step, y: tiny12 * 0.7)
                    }
                }
            }
        }
        .frame(height: tiny12 * 1.4)
        .font(AppFont.sans(tiny12, weight: 600))
        .foregroundStyle(soft.color)
        .accessibilityHidden(true)
    }

    private func label(_ lead: Int) -> String {
        if lead == range.lowerBound { return "Now" }
        let start = timeline.slots[range.lowerBound].validFor
        return HourLabel.axis(timeline.slots[lead].validFor, in: place.timeZone, relativeTo: start)
    }
}
