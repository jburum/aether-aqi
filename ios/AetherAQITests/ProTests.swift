import Foundation
import Testing
@testable import AetherAQI

private let now = SampleAirProvider.now

@Suite("Entitlement")
struct EntitlementTests {
    private func decode(_ json: String) throws -> EntitlementResponse {
        try StoreJSON.decoder().decode(EntitlementResponse.self, from: Data(json.utf8))
    }

    @Test("Reads free/pro, expires_at (or expiresAt) and revoked")
    func decodes() throws {
        let snake = try decode(#"{"tier":"pro","expires_at":"2026-12-01T00:00:00.000Z","revoked":false}"#)
        #expect(snake.tier == "pro")
        #expect(snake.expiresAt != nil)
        #expect(snake.isPro(at: now))
        let camel = try decode(#"{"tier":"pro","expiresAt":"2026-12-01T00:00:00Z","revoked":false}"#)
        #expect(camel.expiresAt == snake.expiresAt)
        let free = try decode(#"{"tier":"free","expires_at":null,"revoked":false}"#)
        #expect(!free.isPro(at: now))
    }

    @Test("Revoked, expired or unknown tiers are Free; Pro with no expiry is Pro")
    func rules() throws {
        #expect(!(try decode(#"{"tier":"pro","expires_at":"2026-12-01T00:00:00Z","revoked":true}"#)).isPro(at: now))
        #expect(!(try decode(#"{"tier":"pro","expires_at":"2026-10-01T00:00:00Z","revoked":false}"#)).isPro(at: now))
        #expect(!(try decode(#"{"tier":"gold","revoked":false}"#)).isPro(at: now))
        #expect(try decode(#"{"tier":"pro","revoked":false}"#).isPro(at: now))
        #expect(try decode(#"{"tier":"pro"}"#).isPro(at: now), "a missing revoked reads as false")
    }
}

@MainActor
@Suite("Paywall and purchases")
struct ProModelTests {
    private func model(_ provider: FixturePurchaseProvider) -> ProModel {
        ProModel(provider: provider, now: { now })
    }

    @Test("Plans are monthly $1.99 then yearly $12.99, and yearly saves 45%")
    func plans() async {
        let pro = model(FixturePurchaseProvider(now: { now }))
        await pro.loadProducts()
        #expect(pro.orderedProducts.map(\.displayPrice) == ["$1.99", "$12.99"])
        #expect(pro.orderedProducts.map(\.period) == [.monthly, .yearly])
        #expect(PaywallText.yearlySaving(monthly: Decimal(string: "1.99")!, yearly: Decimal(string: "12.99")!) == 45)
    }

    @Test("Buying monthly makes the person Pro for a month")
    func buy() async {
        let pro = model(FixturePurchaseProvider(now: { now }))
        #expect(!pro.isPro)
        #expect(await pro.buy(ProductIDs.monthly))
        #expect(pro.isPro)
        #expect(pro.entitlement.expiresAt.map { $0 > now } == true)
        #expect(pro.message == nil)
    }

    @Test("Cancelled, pending and failed purchases leave the person on Free, with the right words")
    func notBought() async {
        let provider = FixturePurchaseProvider(next: .cancel, now: { now })
        let pro = model(provider)
        #expect(!(await pro.buy(ProductIDs.yearly)))
        #expect(!pro.isPro)
        #expect(pro.message == nil, "a cancel needs no message")

        await provider.setNext(.pending)
        #expect(!(await pro.buy(ProductIDs.yearly)))
        #expect(pro.message?.contains("waiting for approval") == true)

        await provider.setNext(.fail)
        #expect(!(await pro.buy(ProductIDs.yearly)))
        #expect(pro.message?.contains("Nothing was charged") == true)
    }

    @Test("Restore finds an earlier purchase, or says there was none")
    func restore() async {
        let found = model(FixturePurchaseProvider(restorable: EntitlementResponse(tier: "pro", expiresAt: nil, revoked: false), now: { now }))
        #expect(await found.restore())
        #expect(found.isPro)

        let none = model(FixturePurchaseProvider(now: { now }))
        #expect(!(await none.restore()))
        #expect(none.message == "No Pro purchase was found for this Apple ID.")
    }

    @Test("The paywall's first line says why it opened")
    func reasons() {
        #expect(PaywallReason.alerts.headline == "Alerts are part of Pro")
        #expect(PaywallReason.places.headline == "More places are part of Pro")
    }
}

@MainActor
@Suite("Pro gates")
struct ProGateTests {
    private func defaults(_ name: String) throws -> UserDefaults {
        let defaults = try #require(UserDefaults(suiteName: "ProGateTests.\(name)"))
        defaults.removePersistentDomain(forName: "ProGateTests.\(name)")
        return defaults
    }

    @Test("Turning on an alert without Pro is refused and leaves it off; with Pro it turns on")
    func alertGate() throws {
        let settings = AlertSettings(defaults: try defaults("alerts"))
        #expect(!settings.request(.smoke, on: true, isPro: false))
        #expect(!settings.isOn(.smoke))
        #expect(settings.request(.smoke, on: true, isPro: true))
        #expect(settings.isOn(.smoke))
        // Turning one off always works.
        #expect(settings.request(.smoke, on: false, isPro: false))
        #expect(!settings.isOn(.smoke))
    }

    @Test("A switch kept from Pro days reads off on Free")
    func lapsed() throws {
        let settings = AlertSettings(defaults: try defaults("lapsed"))
        settings.request(.ozone, on: true, isPro: true)
        #expect(settings.shownOn(.ozone, isPro: true))
        #expect(!settings.shownOn(.ozone, isPro: false))
    }

    @Test("Buying Pro opens the second place at once")
    func placesAfterPurchase() async throws {
        let store = try defaults("places")
        let places = PlacesModel(
            provider: LocalPlacesProvider(defaults: store),
            candidates: try IdahoPlaces.decode(Fixture.data(named: IdahoPlaces.fixtureName)),
            isPro: false,
            defaults: store
        )
        await places.load()
        #expect(places.addNeedsPro)
        let mccall = try #require(places.candidates.first { $0.name == "McCall" })
        #expect(!(await places.add(mccall)))

        let pro = ProModel(provider: FixturePurchaseProvider(now: { now }), now: { now })
        await pro.buy(ProductIDs.yearly)
        places.isPro = pro.isPro
        #expect(!places.addNeedsPro)
        #expect(await places.add(mccall))
        #expect(places.places.count == 2)
    }
}
