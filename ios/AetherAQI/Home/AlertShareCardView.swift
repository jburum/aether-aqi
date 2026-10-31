import CoreTransferable
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// The share card itself: 360 × 450 points, rendered at 3× (1080 × 1350). Our corrected peak is the
/// big serif number in the band's accent; the official AirNow reading, when there is one, sits in its
/// own panel in plain sans with its credit, as on the home screen.
struct AlertShareCardView: View {
    let card: AlertShareCard

    static let size = CGSize(width: 360, height: 450)

    var body: some View {
        let field = card.level?.field ?? Theme.neutralField
        let soft = card.level?.softInk ?? Theme.neutralSoft
        VStack(alignment: .leading, spacing: 10) {
            Text(AlertShareCard.appLabel)
                .font(AppFont.sans(12, weight: 650))
                .foregroundStyle(soft.color)
            VStack(alignment: .leading, spacing: 2) {
                Text(card.placeName)
                    .font(AppFont.sans(22, weight: 700))
                Text(card.placeRegion)
                    .font(AppFont.sans(13, weight: 500))
                    .foregroundStyle(soft.color)
            }
            HStack(spacing: 8) {
                Text("\(card.title) · \(card.severityText)")
                    .font(AppFont.sans(15, weight: 650))
                Text(card.statusText)
                    .font(AppFont.sans(12, weight: 650))
                    .padding(.horizontal, 8)
                    .frame(minHeight: 20)
                    .overlay(Capsule().strokeBorder(Color.white.opacity(0.8), lineWidth: 1))
            }
            Text(card.span)
                .font(AppFont.sans(17, weight: 650))
            if let aqi = card.correctedAqi, let level = card.level {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(aqi, format: .number.grouping(.never))
                        .font(AppFont.serif(64, weight: 800))
                        .monospacedDigit()
                        .foregroundStyle(level.accent.color)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("peak, our forecast")
                            .font(AppFont.sans(12, weight: 650))
                            .foregroundStyle(soft.color)
                        Text(level.label)
                            .font(AppFont.sans(13, weight: 650))
                            .foregroundStyle(level.accent.color)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(AlertShareCard.forecastNote)
                    .font(AppFont.sans(12, weight: 600))
                if card.lowConfidence {
                    Text("Regional and low-confidence.")
                        .font(AppFont.sans(12, weight: 650))
                }
            }
            Spacer(minLength: 0)
            if let official = card.official {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("Official AirNow reading")
                            .font(AppFont.sans(12, weight: 650))
                        Text("Preliminary")
                            .font(AppFont.sans(11, weight: 650))
                            .padding(.horizontal, 6)
                            .overlay(Capsule().strokeBorder(Color.white.opacity(0.6), lineWidth: 1))
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(official.aqi, format: .number.grouping(.never))
                            .font(AppFont.sans(22, weight: 650))
                            .monospacedDigit()
                        Text("AQI · observed \(official.observed)")
                            .font(AppFont.sans(12, weight: 500))
                            .foregroundStyle(soft.color)
                    }
                    Text(official.attribution)
                        .font(AppFont.sans(10, weight: 500))
                        .foregroundStyle(soft.color)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.black.opacity(0.28), in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.white.opacity(0.22), lineWidth: 1))
            }
        }
        .foregroundStyle(Color.white)
        .padding(22)
        .frame(width: Self.size.width, height: Self.size.height, alignment: .topLeading)
        .background(field.color)
        .environment(\.colorScheme, .dark)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(card.summary)
    }
}

/// The card as a PNG for ShareLink. It is rendered only when the person shares.
struct AlertShareImage: Transferable {
    let card: AlertShareCard

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .png) { item in
            try await MainActor.run { try item.png() }
        }
    }

    @MainActor
    func png() throws -> Data {
        let renderer = ImageRenderer(content: AlertShareCardView(card: card))
        renderer.scale = 3
        guard let image = renderer.cgImage else { throw CocoaError(.fileWriteUnknown) }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw CocoaError(.fileWriteUnknown) }
        return data as Data
    }
}

/// Share on an alert row: ShareLink for Pro, the paywall for Free.
struct AlertShareButton: View {
    let card: AlertShareCard
    /// Nil (still renders, tests) shares without a gate.
    let pro: ProModel?
    @State private var showingPaywall = false
    @ScaledMetric(relativeTo: .footnote) private var small13: CGFloat = 13

    var body: some View {
        Group {
            if ShareGate.action(isPro: pro?.isPro ?? true) == .share {
                ShareLink(
                    item: AlertShareImage(card: card),
                    preview: SharePreview("\(card.title) alert, \(card.placeName)", image: Image(systemName: "aqi.medium"))
                ) {
                    label
                }
            } else {
                Button { showingPaywall = true } label: { label }
                    .accessibilityHint("Sharing alerts is part of Pro.")
            }
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .sheet(isPresented: $showingPaywall) {
            if let pro { PaywallView(pro: pro, reason: .share) { showingPaywall = false } }
        }
    }

    private var label: some View {
        Label("Share", systemImage: "square.and.arrow.up")
            .font(AppFont.sans(small13, weight: 650))
    }
}
