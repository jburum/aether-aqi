import Foundation
import StoreKit

/// Pro through StoreKit 2. Only verified transactions count. The entitlement it reports has the same
/// shape the server will send (`EntitlementResponse`): pro with the transaction's expiry, revoked when
/// Apple revoked it. In the simulator it runs against the local `ios/AetherAQI.storekit` once that file is
/// picked as the scheme's StoreKit configuration (ios/README.md); nothing here talks to App Store Connect.
struct StoreKitPurchaseProvider: PurchaseProvider {
    let productIds: [String]

    init(productIds: [String] = ProductIDs.all) {
        self.productIds = productIds
    }

    func products() async throws -> [ProProduct] {
        let found = try await Product.products(for: productIds)
        return found.compactMap { product in
            guard let period = product.subscription?.subscriptionPeriod else { return nil }
            let kind: ProPeriod = period.unit == .year ? .yearly : .monthly
            return ProProduct(id: product.id, displayName: product.displayName, displayPrice: product.displayPrice, price: product.price, period: kind)
        }
    }

    func purchase(_ productId: String) async throws -> PurchaseOutcome {
        guard let product = try await Product.products(for: [productId]).first else { throw PurchaseError.unavailable }
        switch try await product.purchase() {
        case .success(let verification):
            guard case .verified(let transaction) = verification else { throw PurchaseError.unverified }
            await transaction.finish()
            return .purchased(Self.entitlement(from: transaction))
        case .userCancelled:
            return .cancelled
        case .pending:
            return .pending
        @unknown default:
            throw PurchaseError.failed
        }
    }

    func restore() async throws -> EntitlementResponse {
        try await AppStore.sync()
        return try await currentEntitlement()
    }

    /// The best current Pro transaction, or Free. A subscription in Apple's billing grace period is
    /// `grace` and stays Pro past its expiry, as the server's rule does (src/lib/v1/entitlements.ts).
    func currentEntitlement() async throws -> EntitlementResponse {
        let inGrace = await gracePeriodProducts()
        var best: EntitlementResponse = .free
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result, productIds.contains(transaction.productID) else { continue }
            let next = Self.entitlement(from: transaction, inGracePeriod: inGrace.contains(transaction.productID))
            if next.isPro(at: Date()) { best = next }
        }
        return best
    }

    /// Product IDs whose subscription status is in the billing grace period.
    private func gracePeriodProducts() async -> Set<String> {
        guard let products = try? await Product.products(for: productIds) else { return [] }
        var ids = Set<String>()
        for product in products {
            guard let statuses = try? await product.subscription?.status else { continue }
            for status in statuses where status.state == .inGracePeriod {
                if case .verified(let transaction) = status.transaction { ids.insert(transaction.productID) }
            }
        }
        return ids
    }

    /// The state follows the server's `decideState`: revoked, then grace, then expired by the clock, else active.
    static func entitlement(from transaction: Transaction, inGracePeriod: Bool = false, now: Date = Date()) -> EntitlementResponse {
        let state: String
        if transaction.revocationDate != nil {
            state = "revoked"
        } else if inGracePeriod {
            state = "grace"
        } else if let expires = transaction.expirationDate, expires <= now {
            state = "expired"
        } else {
            state = "active"
        }
        let pro = state == "active" || state == "grace"
        return EntitlementResponse(
            tier: pro ? "pro" : "free", expiresAt: transaction.expirationDate, revoked: state == "revoked",
            state: state, pro: pro, product: ProductIDs.planKey(for: transaction.productID)
        )
    }
}
