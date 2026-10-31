import SwiftUI

/// Free vs Pro, the two plans, restore, and the legal links. Opened from the gated spots: turning on an
/// alert, and adding a second place. It closes itself once the person is Pro.
struct PaywallView: View {
    let pro: ProModel
    let reason: PaywallReason
    let done: () -> Void
    @State private var selected = ProductIDs.yearly

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(reason.headline)
                            .font(.title2.weight(.bold))
                            .accessibilityAddTraits(.isHeader)
                        Text("Pro adds alerts for smoke, winter inversions and summer ozone, up to 5 saved places, and a share card for alerts.")
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    comparison
                    plans
                    VStack(spacing: 10) {
                        Button {
                            Task { if await pro.buy(selected) { done() } }
                        } label: {
                            Text(pro.busy ? "Working…" : "Subscribe")
                                .font(.headline)
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(pro.busy || pro.orderedProducts.isEmpty)

                        Button("Restore purchases") {
                            Task { if await pro.restore() { done() } }
                        }
                        .frame(minHeight: 44)
                        .disabled(pro.busy)
                    }
                    if let message = pro.message {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text(PaywallText.renewal)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 16) {
                            Link("Terms of Use", destination: PaywallText.termsURL)
                            Link("Privacy Policy", destination: PaywallText.privacyURL)
                        }
                        .font(.footnote)
                    }
                }
                .padding(20)
            }
            .navigationTitle("Pro")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Not now", action: done) }
            }
            .task { await pro.loadProducts() }
        }
    }

    private var comparison: some View {
        VStack(spacing: 0) {
            ComparisonRow(feature: "", free: "Free", pro: "Pro", header: true)
            ComparisonRow(feature: "Air now, 48-hour timeline, best window, outlook", free: "Yes", pro: "Yes")
            ComparisonRow(feature: "Smoke, inversion and ozone alerts", free: "No", pro: "Yes")
            ComparisonRow(feature: "Saved places", free: "1", pro: "Up to 5")
            ComparisonRow(feature: "Alert share card", free: "No", pro: "Yes")
        }
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder private var plans: some View {
        switch pro.products {
        case .loading:
            ProgressView("Loading plans…")
                .frame(maxWidth: .infinity, minHeight: 88)
        case .failed:
            Text("Couldn't load the plans from the App Store. Try again later.")
                .foregroundStyle(.secondary)
        case .loaded:
            let list = pro.orderedProducts
            let monthly = list.first { $0.period == .monthly }
            VStack(spacing: 10) {
                ForEach(list) { product in
                    PlanCard(
                        product: product,
                        saving: product.period == .yearly ? monthly.flatMap { PaywallText.yearlySaving(monthly: $0.price, yearly: product.price) } : nil,
                        selected: selected == product.id
                    ) { selected = product.id }
                }
            }
        }
    }
}

private struct ComparisonRow: View {
    let feature: String
    let free: String
    let pro: String
    var header = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(feature)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            Text(free).frame(minWidth: 52)
            Text(pro).frame(minWidth: 64)
        }
        .font(header ? .footnote.weight(.semibold) : .subheadline)
        .foregroundStyle(header ? .secondary : .primary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(header ? "Free compared with Pro" : "\(feature). Free: \(free). Pro: \(pro).")
    }
}

private struct PlanCard: View {
    let product: ProProduct
    let saving: Int?
    let selected: Bool
    let choose: () -> Void

    private var periodText: String { product.period == .monthly ? "per month" : "per year" }

    var body: some View {
        Button(action: choose) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(product.period == .monthly ? "Monthly" : "Yearly").font(.headline)
                    if let saving { Text("Save \(saving)%").font(.footnote).foregroundStyle(.secondary) }
                }
                Spacer()
                Text("\(product.displayPrice) \(periodText)").font(.body.weight(.semibold))
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .accessibilityHidden(true)
            }
            .padding(14)
            .frame(minHeight: 56)
            .contentShape(Rectangle())
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(selected ? Color.accentColor : Color.secondary.opacity(0.4), lineWidth: selected ? 2 : 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(product.period == .monthly ? "Monthly" : "Yearly"), \(product.displayPrice) \(periodText)\(saving.map { ", save \($0) percent" } ?? "")")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
