import SwiftUI

@main
struct AetherAQIApp: App {
    init() {
        AppFont.register()
    }

    var body: some Scene {
        WindowGroup {
            // Phase 0: sample data only. Pick a screen with `-AQIScenario good|moderate|usg|unhealthy|very|hazardous|empty|error|loading`.
            HomeScreen(model: HomeModel(provider: SampleAirProvider(scenario: .fromLaunchArguments())))
        }
    }
}
