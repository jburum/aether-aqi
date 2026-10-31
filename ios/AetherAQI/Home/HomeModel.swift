import Foundation
import Observation

/// Drives the Free home screen: loading, the air for one place, no place yet, or a failed load.
@MainActor
@Observable
final class HomeModel {
    enum State: Equatable {
        case loading
        case loaded(HomeSnapshot)
        case empty
        case failed
    }

    private(set) var state: State = .loading
    private let provider: any AirDataProvider

    init(provider: any AirDataProvider) {
        self.provider = provider
    }

    /// The level that tints the whole app, or nil for the neutral field (loading, empty, error).
    var level: AirLevel? {
        if case .loaded(let snapshot) = state { snapshot.now.level } else { nil }
    }

    func load() async {
        state = .loading
        do {
            if let snapshot = try await provider.homeSnapshot() {
                state = .loaded(snapshot)
            } else {
                state = .empty
            }
        } catch is CancellationError {
            // The view went away; keep whatever is on screen.
        } catch {
            // Never leave an old number up as if it were current.
            state = .failed
        }
    }
}
