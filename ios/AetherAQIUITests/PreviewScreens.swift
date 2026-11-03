import XCTest

/// Every screen the app has today, one screenshot each, for the preview set in docs/preview/. Run it with
/// the AetherAQIScreenshots scheme on each device size (ios/README.md, "Sheet screenshots"). The images
/// are attached to the test result, and also written to `TEST_RUNNER_SCREENSHOT_DIR` when it is set.
final class PreviewScreens: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
    }

    private func launch(_ arguments: [String]) {
        app.launchArguments = arguments
        app.launch()
    }

    // MARK: Home

    func testHomeGood() {
        launch(["-AQIScenario", "good"])
        waitForHome()
        save("01-home-good")
        app.swipeUp()
        save("02-home-good-timeline")
        app.swipeUp()
        save("03-home-good-window-outlook")
    }

    func testHomeUnhealthyForSensitiveGroups() {
        launch(["-AQIScenario", "usg"])
        waitForHome()
        save("04-home-usg-smoke-alert")
    }

    func testHomeHazardousWinter() {
        launch(["-AQIScenario", "hazardous", "-AQIAlerts", "winter"])
        waitForHome()
        save("05-home-hazardous-inversion")
    }

    func testHomeModerateWeekdayOzone() {
        launch(["-AQIScenario", "moderate", "-AQIOutlook", "weekday", "-AQIAlerts", "ozone"])
        waitForHome()
        save("06-home-moderate-ozone")
    }

    func testHomeEmpty() {
        launch(["-AQIScenario", "empty"])
        save("07-home-empty")
    }

    func testHomeError() {
        launch(["-AQIScenario", "error"])
        save("08-home-error")
    }

    func testHomeLoading() {
        launch(["-AQIScenario", "loading", "-AQITimeline", "loading", "-AQIOutlook", "loading", "-AQIAlerts", "loading"])
        save("09-home-loading")
    }

    // MARK: Sheets on Free

    func testAlertSettingsAndPaywall() {
        launch(["-AQIScenario", "good"])
        openAlertSettings()
        save("10-alert-settings")
        let firstSwitch = app.switches.firstMatch
        XCTAssertTrue(firstSwitch.waitForExistence(timeout: 10))
        // A tap on the row's middle lands on its label; the switch itself sits at the right edge.
        firstSwitch.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        waitForPaywall()
        save("11-paywall-alerts")
    }

    func testPlacesAndPaywall() {
        launch(["-AQIScenario", "good"])
        openPlaces()
        save("12-places-free")
        let add = app.buttons["Add a place with Pro"]
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        add.tap()
        waitForPaywall()
        save("13-paywall-places")
    }

    func testSharePaywall() {
        launch(["-AQIScenario", "usg"])
        let share = app.buttons["Share"].firstMatch
        XCTAssertTrue(share.waitForExistence(timeout: 10))
        share.tap()
        waitForPaywall()
        save("14-paywall-share")
    }

    // MARK: Pro (local stub)

    func testAddPlaceOnPro() {
        launch(["-AQIScenario", "good", "-AQIProStub", "YES"])
        openPlaces()
        let add = app.buttons["Add a place"]
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        add.tap()
        XCTAssertTrue(app.navigationBars["Add a place"].waitForExistence(timeout: 10))
        save("15-add-a-place")
    }

    func testShareSheetOnPro() {
        launch(["-AQIScenario", "usg", "-AQIProStub", "YES"])
        let share = app.buttons["Share"].firstMatch
        XCTAssertTrue(share.waitForExistence(timeout: 10))
        share.tap()
        // The system share sheet, with the alert card as a PNG.
        Thread.sleep(forTimeInterval: 2)
        save("16-share-sheet")
    }

    // MARK: Main flow (for a screen recording; no screenshots)

    func testMainFlow() {
        launch(["-AQIScenario", "usg"])
        waitForHome()
        Thread.sleep(forTimeInterval: 2)
        app.swipeUp()
        Thread.sleep(forTimeInterval: 2)
        app.swipeUp()
        Thread.sleep(forTimeInterval: 2)
        app.swipeDown()
        app.swipeDown()
        Thread.sleep(forTimeInterval: 1)
        openPlaces()
        Thread.sleep(forTimeInterval: 2)
        app.buttons["Done"].tap()
        openAlertSettings()
        Thread.sleep(forTimeInterval: 2)
        app.switches.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        waitForPaywall()
        Thread.sleep(forTimeInterval: 3)
        app.buttons["Not now"].tap()
        Thread.sleep(forTimeInterval: 1)
        app.buttons["Done"].tap()
        Thread.sleep(forTimeInterval: 2)
    }

    // MARK: Steps

    private func waitForHome() {
        XCTAssertTrue(app.buttons["Alert settings"].waitForExistence(timeout: 10))
    }

    private func openPlaces() {
        let placeLine = app.buttons["Boise, Idaho"]
        XCTAssertTrue(placeLine.waitForExistence(timeout: 10))
        placeLine.tap()
        XCTAssertTrue(app.navigationBars["Places"].waitForExistence(timeout: 10))
    }

    private func openAlertSettings() {
        let button = app.buttons["Alert settings"]
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        button.tap()
        XCTAssertTrue(app.navigationBars["Alert settings"].waitForExistence(timeout: 10))
    }

    private func waitForPaywall() {
        XCTAssertTrue(app.navigationBars["Pro"].waitForExistence(timeout: 10))
        // The plans load from the sample store; let them land before the picture.
        _ = app.buttons["Restore purchases"].waitForExistence(timeout: 10)
    }

    /// Waits for the screen to settle, then keeps it.
    private func save(_ name: String) {
        Thread.sleep(forTimeInterval: 1)
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = ProcessInfo.processInfo.environment["SCREENSHOT_DIR"], !dir.isEmpty {
            let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name).png")
            XCTAssertNoThrow(try shot.pngRepresentation.write(to: url))
        }
    }
}
