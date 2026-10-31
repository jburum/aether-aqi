import SwiftUI

/// Alerts on the home screen: active first, then upcoming, each with its severity, its time span in the
/// place's zone, and the reason the rule gave. A heads up carries the low-confidence label in words.
/// "Alert settings" opens the switches; the list shows whether or not any switch is on.
struct AlertsSection: View {
    let model: HomeModel
    let settings: AlertSettings
    /// The person's plan. Nil (still renders, tests) leaves the switches ungated.
    var pro: ProModel? = nil
    let soft: RGB
    @State private var showingSettings = false
    @ScaledMetric(relativeTo: .footnote) private var small13: CGFloat = 13
    @ScaledMetric(relativeTo: .subheadline) private var body15: CGFloat = 15

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) {
                    title.fixedSize()
                    Spacer(minLength: 8)
                    settingsButton
                }
                VStack(alignment: .leading, spacing: 4) {
                    title
                    settingsButton
                }
            }
            content
        }
        .sheet(isPresented: $showingSettings) {
            AlertSettingsView(settings: settings, pro: pro) { showingSettings = false }
        }
    }

    private var title: some View {
        Text("Alerts · our forecast")
            .font(AppFont.sans(small13, weight: 650))
            .foregroundStyle(soft.color)
            .accessibilityAddTraits(.isHeader)
    }

    private var settingsButton: some View {
        Button("Alert settings") { showingSettings = true }
            .font(AppFont.sans(small13, weight: 650))
            .buttonStyle(.plain)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
    }

    @ViewBuilder private var content: some View {
        switch model.alertsState {
        case .loading:
            Text("Checking for alerts…")
                .font(AppFont.sans(body15, weight: 500))
                .foregroundStyle(soft.color)
        case .failed:
            VStack(alignment: .leading, spacing: 8) {
                Text("Couldn't load alerts.")
                    .font(AppFont.sans(body15, weight: 500))
                    .foregroundStyle(soft.color)
                OutlineButton(title: "Try again") { Task { await model.reloadAlerts() } }
            }
        case .loaded(let alerts):
            if alerts.isEmpty {
                Text(AlertsDisplay.emptyText)
                    .font(AppFont.sans(body15, weight: 500))
                    .foregroundStyle(soft.color)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(alerts.rows) { row in
                    AlertRow(row: row, card: shareCard(row), pro: pro, soft: soft)
                }
            }
        }
    }

    /// The share card for a row: the place on screen and its official reading, when there is one.
    private func shareCard(_ row: AlertRowDisplay) -> AlertShareCard? {
        guard case .loaded(let snapshot) = model.state else { return nil }
        return AlertShareCard(row: row, place: snapshot.place, official: snapshot.official)
    }
}

private struct AlertRow: View {
    let row: AlertRowDisplay
    /// Nil hides Share (no place loaded yet).
    let card: AlertShareCard?
    let pro: ProModel?
    let soft: RGB
    @ScaledMetric(relativeTo: .subheadline) private var body15: CGFloat = 15
    @ScaledMetric(relativeTo: .footnote) private var small13: CGFloat = 13
    @ScaledMetric(relativeTo: .footnote) private var swatch: CGFloat = 10

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            details
                // The row reads as one VoiceOver element; Share stays its own button below it.
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(row.accessibilityLabel)
            if let card {
                AlertShareButton(card: card, pro: pro)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(row.lowConfidence ? 0.03 : 0.08), in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.white.opacity(row.lowConfidence ? 0.5 : 0.22), style: StrokeStyle(lineWidth: 1, dash: row.lowConfidence ? [5, 4] : []))
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 5) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    heading.fixedSize()
                    Spacer(minLength: 8)
                    status.fixedSize()
                }
                VStack(alignment: .leading, spacing: 3) {
                    heading
                    status
                }
            }
            Text(row.span)
                .font(AppFont.sans(body15, weight: 650))
                .fixedSize(horizontal: false, vertical: true)
            if row.lowConfidence {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: "exclamationmark.circle")
                        .font(.system(size: small13 - 1, weight: .semibold))
                        .accessibilityHidden(true)
                    Text("Regional and low-confidence")
                        .font(AppFont.sans(small13, weight: 650))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Text(row.reason)
                .font(AppFont.sans(small13, weight: 500))
                .foregroundStyle(soft.color)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var heading: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if let level = row.swatch {
                Circle()
                    .fill(Theme.bar(level).color)
                    .overlay(Circle().strokeBorder(Color.white.opacity(0.7), lineWidth: 1))
                    .frame(width: swatch, height: swatch)
                    .accessibilityHidden(true)
            }
            Text("\(row.title) · \(row.severityText)")
                .font(AppFont.sans(body15, weight: 650))
        }
    }

    private var status: some View {
        Text(row.statusText)
            .font(AppFont.sans(small13, weight: 650))
            .padding(.horizontal, 8)
            .frame(minHeight: 22)
            .overlay(Capsule().strokeBorder(Color.white.opacity(row.isActive ? 0.9 : 0.45), lineWidth: 1))
    }
}

/// One switch per rule, all off until the person turns one on. The choice is kept on this phone only:
/// no notification permission prompt, no push, no network.
struct AlertSettingsView: View {
    let settings: AlertSettings
    /// Alerts are Pro: turning one on without Pro opens the paywall and leaves the switch off.
    var pro: ProModel? = nil
    let done: () -> Void
    @State private var showingPaywall = false

    private var isPro: Bool { pro?.isPro ?? true }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(AlertRule.allCases, id: \.self) { rule in
                        Toggle(isOn: Binding(
                            get: { settings.shownOn(rule, isPro: isPro) },
                            set: { if !settings.request(rule, on: $0, isPro: isPro) { showingPaywall = true } }
                        )) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(rule.title)
                                Text(rule.detail)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                } footer: {
                    Text("Every alert is off until you turn it on. Alerts are part of Pro. Your choice is saved on this phone only. The app doesn't send notifications yet.")
                }
            }
            .navigationTitle("Alert settings")
            .sheet(isPresented: $showingPaywall) {
                if let pro { PaywallView(pro: pro, reason: .alerts) { showingPaywall = false } }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: done)
                }
            }
        }
    }
}
