import SwiftUI
import CoreLocation

struct ContentView: View {
    @StateObject private var location = LocationManager()
    @State private var payload: AirQualityPayload?
    @State private var error: String?
    @State private var loading = false

    // Fallback for simulator/denied permission: Boise, ID
    private let fallback = CLLocationCoordinate2D(latitude: 43.615, longitude: -116.2023)

    var body: some View {
        let meta = AQIMeta.of(payload?.current.us_aqi)
        ScrollView {
            VStack(spacing: 20) {
                Text(location.placeName ?? (location.coordinate == nil ? "Boise, ID" : "Current location"))
                    .font(.headline).foregroundStyle(.secondary)
                ZStack {
                    Circle().fill(meta.color.opacity(0.18))
                    Circle().stroke(meta.color, lineWidth: 10)
                    VStack {
                        Text(payload?.current.us_aqi.map { String(Int($0.rounded())) } ?? "—")
                            .font(.system(size: 72, weight: .bold, design: .rounded))
                        Text("US AQI").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .frame(width: 220, height: 220)
                Text(meta.label).font(.title2.bold()).foregroundStyle(meta.color)
                Text(meta.advice).multilineTextAlignment(.center).padding(.horizontal)
                if let c = payload?.current {
                    Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 8) {
                        row("Main pollutant", AQIService.mainPollutant(c))
                        row("PM2.5", fmt(c.pm2_5, "µg/m³"))
                        row("PM10", fmt(c.pm10, "µg/m³"))
                        row("Ozone", fmt(c.ozone, "µg/m³"))
                    }
                    .padding().background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
                }
                if loading { ProgressView() }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                Button("Use my location") { location.request() }.buttonStyle(.borderedProminent)
            }
            .padding()
        }
        .task { await load() }
        .refreshable { await load() }
        .onChange(of: location.coordinate?.latitude) { Task { await load() } }
    }

    private func row(_ k: String, _ v: String) -> some View {
        GridRow { Text(k).foregroundStyle(.secondary); Text(v).bold() }
    }

    private func fmt(_ v: Double?, _ unit: String) -> String {
        v.map { String(format: "%.1f %@", $0, unit) } ?? "—"
    }

    private func load() async {
        let c = location.coordinate ?? fallback
        loading = true; defer { loading = false }
        do { payload = try await AQIService.fetch(lat: c.latitude, lon: c.longitude); error = nil }
        catch { self.error = error.localizedDescription }
    }
}
