import XCTest

/// Opens the sheets that need a tap (Places, Alert settings, the Pro paywall) and keeps a screenshot of
/// each. Run it with the AetherAQIScreenshots scheme (ios/README.md, "Sheet screenshots"). The images
/// are attached to the test result, and also written to `TEST_RUNNER_SCREENSHOT_DIR` when it is set.
final class SheetScreenshots: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        // Sample Boise data on Free, so a switch in Alert settings opens the paywall.
        app.launchArguments = ["-AQIScenario", "good"]
        app.launch()
    }

    func testPlacesSheet() {
        openPlaces()
        save("sheet-places")
    }

    func testAlertSettingsSheet() {
        openAlertSettings()
        save("sheet-alert-settings")
    }

    func testPaywallSheet() {
        openAlertSettings()
        let firstSwitch = app.switches.firstMatch
        XCTAssertTrue(firstSwitch.waitForExistence(timeout: 10))
        // A tap on the row's middle lands on its label; the switch itself sits at the right edge.
        firstSwitch.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertTrue(app.navigationBars["Pro"].waitForExistence(timeout: 10))
        // The plans load from the sample store; let them land before the picture.
        _ = app.buttons["Restore purchases"].waitForExistence(timeout: 10)
        save("sheet-paywall")
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

    /// Waits for the sheet to settle, then keeps the screen.
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
