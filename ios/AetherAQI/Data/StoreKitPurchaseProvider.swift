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

    /// The best current Pro transaction, or Free.
    func currentEntitlement() async throws -> EntitlementResponse {
        var best: EntitlementResponse = .free
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result, productIds.contains(transaction.productID) else { continue }
            let next = Self.entitlement(from: transaction)
            if next.isPro(at: Date()) { best = next }
        }
        return best
    }

    static func entitlement(from transaction: Transaction) -> EntitlementResponse {
        EntitlementResponse(tier: "pro", expiresAt: transaction.expirationDate, revoked: transaction.revocationDate != nil)
    }
}
