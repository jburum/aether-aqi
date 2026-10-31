import SwiftUI

@main
struct AetherAQIApp: App {
    init() {
        AppFont.register()
    }

    var body: some Scene {
        WindowGroup {
            // Sample data only. Pick a screen with `-AQIScenario good|moderate|usg|unhealthy|very|hazardous|empty|error|loading`
            // and the timeline with `-AQITimeline fixture|empty|error|loading`, and the best window and outlook
            // with `-AQIOutlook weekend|weekday|none|error|loading`, and alerts with
            // `-AQIAlerts smoke|winter|ozone|empty|error|loading`. The clock is pinned to the
            // sample's "now", three hours into the recorded NOAA cycle.
            HomeScreen(model: HomeModel(
                provider: SampleAirProvider(
                    scenario: .fromLaunchArguments(),
                    timeline: .fromLaunchArguments(),
                    outlookScenario: .fromLaunchArguments(),
                    alertsScenario: .fromLaunchArguments()
                ),
                now: { SampleAirProvider.now }
            ))
        }
    }
}
