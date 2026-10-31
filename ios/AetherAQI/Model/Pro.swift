import Foundation
import Observation

// Pro (Phase 3): $1.99 a month or $12.99 a year (v1-plan.md). Pro adds smoke, inversion and ozone alerts,
// up to 5 saved places, and the alert share card. Purchases go through `PurchaseProvider`: StoreKit 2 in
// the app, a fixture in tests and sample runs. No App Store Connect setup, no entitlement files.

/// What the server says about the person's plan. Shaped after the coming GET entitlement route:
/// `tier` free or pro, `expires_at`, `revoked`. Both `expires_at` and `expiresAt` are read, because the
/// route isn't merged yet and the v1 routes so far use camelCase.
struct EntitlementResponse: Decodable, Equatable, Sendable {
    let tier: String
    let expiresAt: Date?
    let revoked: Bool

    static let free = EntitlementResponse(tier: "free", expiresAt: nil, revoked: false)

    init(tier: String, expiresAt: Date?, revoked: Bool) {
        self.tier = tier
        self.expiresAt = expiresAt
        self.revoked = revoked
    }

    private enum Keys: String, CodingKey {
        case tier, revoked, expiresAt
        case expiresAtSnake = "expires_at"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        tier = try container.decode(String.self, forKey: .tier)
        revoked = try container.decodeIfPresent(Bool.self, forKey: .revoked) ?? false
        expiresAt = try container.decodeIfPresent(Date.self, forKey: .expiresAt)
            ?? container.decodeIfPresent(Date.self, forKey: .expiresAtSnake)
    }

    /// Pro only when the tier says so, it isn't revoked, and it hasn't run out. Anything else is Free.
    func isPro(at now: Date) -> Bool {
        guard tier == "pro", !revoked else { return false }
        if let expiresAt { return expiresAt > now }
        return true
    }
}

enum ProPeriod: String, Codable, Sendable {
    case monthly, yearly
}

/// One Pro plan as the store shows it. The price string comes from the store, already localized.
struct ProProduct: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let displayName: String
    let displayPrice: String
    /// For the yearly saving only. The screen shows `displayPrice`.
    let price: Decimal
    let period: ProPeriod
}

enum ProductIDs {
    /// Placeholders until the app has a bundle ID (docs/appstore/ROADMAP.md).
    static let monthly = "com.example.aetheraqi.pro.monthly"
    static let yearly = "com.example.aetheraqi.pro.yearly"
    static let all = [monthly, yearly]
}

enum PurchaseOutcome: Equatable, Sendable {
    case purchased(EntitlementResponse)
    case cancelled
    /// Waiting on Ask to Buy or a payment check. Not Pro yet.
    case pending
}

enum PurchaseError: Error, Equatable, Sendable {
    case unavailable
    case failed
    case unverified
}

/// Where Pro is bought and checked. StoreKitPurchaseProvider in the app; FixturePurchaseProvider in tests.
protocol PurchaseProvider: Sendable {
    func products() async throws -> [ProProduct]
    func purchase(_ productId: String) async throws -> PurchaseOutcome
    /// Restore purchases: sync with the store, then read the entitlement again.
    func restore() async throws -> EntitlementResponse
    func currentEntitlement() async throws -> EntitlementResponse
}

/// Canned plans and outcomes. Prices match the plan: $1.99 a month, $12.99 a year.
actor FixturePurchaseProvider: PurchaseProvider {
    enum Next: Sendable { case buy, cancel, pending, fail }

    static let products = [
        ProProduct(id: ProductIDs.monthly, displayName: "Pro Monthly", displayPrice: "$1.99", price: Decimal(string: "1.99")!, period: .monthly),
        ProProduct(id: ProductIDs.yearly, displayName: "Pro Yearly", displayPrice: "$12.99", price: Decimal(string: "12.99")!, period: .yearly),
    ]

    private var entitlement: EntitlementResponse
    /// What restore finds in the store (a purchase made on another phone, say).
    private var restorable: EntitlementResponse?
    private var next: Next
    private let now: @Sendable () -> Date

    init(
        startingPro: Bool = false,
        restorable: EntitlementResponse? = nil,
        next: Next = .buy,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.now = now
        entitlement = startingPro ? EntitlementResponse(tier: "pro", expiresAt: nil, revoked: false) : .free
        self.restorable = restorable
        self.next = next
    }

    func setNext(_ next: Next) { self.next = next }

    func products() async throws -> [ProProduct] { Self.products }

    func purchase(_ productId: String) async throws -> PurchaseOutcome {
        guard let product = Self.products.first(where: { $0.id == productId }) else { throw PurchaseError.unavailable }
        switch next {
        case .cancel: return .cancelled
        case .pending: return .pending
        case .fail: throw PurchaseError.failed
        case .buy:
            let length: Calendar.Component = product.period == .monthly ? .month : .year
            let expires = Calendar(identifier: .gregorian).date(byAdding: length, value: 1, to: now())
            entitlement = EntitlementResponse(tier: "pro", expiresAt: expires, revoked: false)
            return .purchased(entitlement)
        }
    }

    func restore() async throws -> EntitlementResponse {
        if let restorable { entitlement = restorable }
        return entitlement
    }

    func currentEntitlement() async throws -> EntitlementResponse { entitlement }
}

/// Why the paywall opened: the first line it shows.
enum PaywallReason: Equatable, Sendable {
    case alerts
    case places
    case share
    case browse

    var headline: String {
        switch self {
        case .alerts: "Alerts are part of Pro"
        case .places: "More places are part of Pro"
        case .share: "Sharing alerts is part of Pro"
        case .browse: "Air Quality Forecast Pro"
        }
    }
}

/// The person's plan and the paywall's state.
@MainActor
@Observable
final class ProModel {
    enum Products: Equatable {
        case loading
        case loaded([ProProduct])
        case failed
    }

    private(set) var entitlement: EntitlementResponse = .free
    private(set) var products: Products = .loading
    /// A purchase or restore is running: the buttons wait.
    private(set) var busy = false
    /// One line for the paywall: pending, cancelled, failed, or nothing to restore.
    private(set) var message: String?

    private let provider: any PurchaseProvider
    private let now: @Sendable () -> Date

    init(provider: any PurchaseProvider, now: @escaping @Sendable () -> Date = { Date() }) {
        self.provider = provider
        self.now = now
    }

    var isPro: Bool { entitlement.isPro(at: now()) }

    /// Monthly first, then yearly.
    var orderedProducts: [ProProduct] {
        guard case .loaded(let list) = products else { return [] }
        return list.sorted { ($0.period == .monthly ? 0 : 1) < ($1.period == .monthly ? 0 : 1) }
    }

    func refresh() async {
        if let current = try? await provider.currentEntitlement() { entitlement = current }
    }

    func loadProducts() async {
        if case .loaded = products { return }
        products = .loading
        do {
            let list = try await provider.products()
            products = list.isEmpty ? .failed : .loaded(list)
        } catch {
            products = .failed
        }
    }

    /// True when the person is Pro afterwards.
    @discardableResult
    func buy(_ productId: String) async -> Bool {
        guard !busy else { return false }
        busy = true
        defer { busy = false }
        message = nil
        do {
            switch try await provider.purchase(productId) {
            case .purchased(let next):
                entitlement = next
                if !isPro { message = "The store didn't confirm Pro. Try Restore purchases." }
            case .cancelled:
                break
            case .pending:
                message = "Your purchase is waiting for approval. Pro turns on when it goes through."
            }
        } catch {
            message = "The purchase didn't go through. Nothing was charged."
        }
        return isPro
    }

    @discardableResult
    func restore() async -> Bool {
        guard !busy else { return false }
        busy = true
        defer { busy = false }
        message = nil
        do {
            entitlement = try await provider.restore()
            if !isPro { message = "No Pro purchase was found for this Apple ID." }
        } catch {
            message = "Couldn't reach the App Store. Try again."
        }
        return isPro
    }
}

enum PaywallText {
    static let renewal =
        "Payment is charged to your Apple ID when you confirm. The subscription renews automatically unless you cancel it at least 24 hours before the end of the period. Manage or cancel it in Settings."

    /// Placeholders: the real pages come with the App Store listing (docs/IOS-APP-STORE.md).
    static let termsURL = URL(string: "https://example.com/aether-aqi/terms")!
    static let privacyURL = URL(string: "https://example.com/aether-aqi/privacy")!

    /// "Save 45%" for yearly against twelve months, from the two store prices.
    static func yearlySaving(monthly: Decimal, yearly: Decimal) -> Int? {
        guard monthly > 0 else { return nil }
        let full = monthly * 12
        let saved = (full - yearly) / full * 100
        let percent = NSDecimalNumber(decimal: saved).doubleValue
        return percent >= 1 ? Int(percent.rounded(.down)) : nil
    }
}
