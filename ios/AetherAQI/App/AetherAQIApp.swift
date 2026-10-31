import SwiftUI

@main
struct AetherAQIApp: App {
    init() {
        AppFont.register()
    }

    /// Pro purchases. `-AQIStore storekit` uses StoreKit 2 against the local AetherAQI.storekit file;
    /// otherwise the fixture plans ($1.99 / $12.99), Free at start unless `-AQIProStub YES`.
    static func purchaseProvider(_ defaults: UserDefaults = .standard) -> any PurchaseProvider {
        if defaults.string(forKey: "AQIStore") == "storekit" { return StoreKitPurchaseProvider() }
        return FixturePurchaseProvider(startingPro: ProStub.isOn(defaults))
    }

    var body: some Scene {
        WindowGroup {
            // Sample data only. Pick a screen with `-AQIScenario good|moderate|usg|unhealthy|very|hazardous|empty|error|loading`
            // and the timeline with `-AQITimeline fixture|empty|error|loading`, and the best window and outlook
            // with `-AQIOutlook weekend|weekday|none|error|loading`, and alerts with
            // `-AQIAlerts smoke|winter|ozone|empty|error|loading`. The clock is pinned to the
            // sample's "now", three hours into the recorded NOAA cycle.
            // Saved places live on this phone (LocalPlacesProvider); pick from the bundled Idaho list.
            // `-AQIProStub YES` turns on the local Pro stub (more than one place). No StoreKit.
            HomeScreen(
                model: HomeModel(
                    provider: SampleAirProvider(
                        scenario: .fromLaunchArguments(),
                        timeline: .fromLaunchArguments(),
                        outlookScenario: .fromLaunchArguments(),
                        alertsScenario: .fromLaunchArguments()
                    ),
                    now: { SampleAirProvider.now }
                ),
                places: PlacesModel(
                    provider: LocalPlacesProvider(),
                    candidates: (try? IdahoPlaces.decode(BundledFixture.data(named: IdahoPlaces.fixtureName))) ?? [],
                    isPro: ProStub.isOn()
                ),
                pro: ProModel(provider: Self.purchaseProvider())
            )
        }
    }
}
