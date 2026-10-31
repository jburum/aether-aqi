import Foundation
import Observation

// Saved places (Phase 3). Shaped after `saved_place` (docs/v1/WEEK1.md) and `SavedPlace` in
// src/lib/v1/types.ts: GET /api/v1/places returns { places }, POST adds one, DELETE /places/:id removes
// one, and the server caps a person at 5 (`place_cap`). Only a local, fixture-backed store exists here.

/// One saved place, as the API sends it.
struct SavedPlace: Codable, Equatable, Identifiable, Sendable {
    let id: String
    var name: String
    let latitude: Double
    let longitude: Double
    let valley: String?
    let alertAt: Int?
    var position: Int
    let createdAt: Date
}

/// A place the person can add, from the bundled Idaho list (no geocoding service).
struct PlaceCandidate: Codable, Equatable, Identifiable, Sendable {
    var id: String { name }
    let name: String
    let region: String
    let latitude: Double
    let longitude: Double
    let valley: String?
    /// IANA zone. Not part of `saved_place`; the app keeps it beside the place for local times.
    let timeZone: String
}

enum PlaceLimits {
    /// The server's cap (`MAX_SAVED_PLACES` in src/lib/v1/rules.ts).
    static let maxSaved = 5
    /// Free keeps one place. More than one is Pro (v1-plan.md).
    static let freeSaved = 1
    static let nameMax = 60
}

/// Why a change was refused. Each has the words the screen shows.
enum PlaceProblem: Error, Equatable, Sendable {
    case atCap
    case needsPro
    case alreadySaved
    case emptyName
    case nameTooLong
    case notFound

    var message: String {
        switch self {
        case .atCap: "You have \(PlaceLimits.maxSaved) places, the most you can save. Delete one to add another."
        case .needsPro: "Free includes one place. More places are part of Pro."
        case .alreadySaved: "That place is already in your list."
        case .emptyName: "A place needs a name."
        case .nameTooLong: "Keep the name to \(PlaceLimits.nameMax) characters."
        case .notFound: "That place is no longer in your list."
        }
    }
}

/// Where saved places are kept. A live provider sends the same calls to /api/v1/places.
protocol SavedPlacesProvider: Sendable {
    func list() async throws -> [SavedPlace]
    func add(_ candidate: PlaceCandidate, now: Date) async throws -> SavedPlace
    /// Local only for now: the API has no rename route yet.
    func rename(id: String, to name: String) async throws -> SavedPlace
    func delete(id: String) async throws
}

/// Saved places in UserDefaults on this phone, as JSON in the API's shape. First run starts with Boise.
/// The 5-place cap is enforced here too, as the server's trigger does.
final class LocalPlacesProvider: SavedPlacesProvider, @unchecked Sendable {
    static let storageKey = "places.saved.v1"
    static let boise = SavedPlace(
        id: "place_boise", name: "Boise", latitude: 43.615, longitude: -116.202, valley: "Treasure Valley",
        alertAt: nil, position: 0, createdAt: Date(timeIntervalSince1970: 1_793_448_000)
    )

    private let defaults: UserDefaults
    private let lock = NSLock()

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func list() async throws -> [SavedPlace] {
        lock.withLock { load() }
    }

    func add(_ candidate: PlaceCandidate, now: Date) async throws -> SavedPlace {
        try lock.withLock {
            var places = load()
            guard places.count < PlaceLimits.maxSaved else { throw PlaceProblem.atCap }
            guard !places.contains(where: { $0.name == candidate.name && $0.latitude == candidate.latitude && $0.longitude == candidate.longitude }) else {
                throw PlaceProblem.alreadySaved
            }
            let place = SavedPlace(
                id: "place_\(UUID().uuidString.lowercased())", name: candidate.name,
                latitude: candidate.latitude, longitude: candidate.longitude, valley: candidate.valley,
                alertAt: nil, position: (places.map(\.position).max() ?? -1) + 1, createdAt: now
            )
            places.append(place)
            save(places)
            return place
        }
    }

    func rename(id: String, to name: String) async throws -> SavedPlace {
        try lock.withLock {
            var places = load()
            guard let index = places.firstIndex(where: { $0.id == id }) else { throw PlaceProblem.notFound }
            places[index].name = name
            save(places)
            return places[index]
        }
    }

    func delete(id: String) async throws {
        try lock.withLock {
            var places = load()
            guard places.contains(where: { $0.id == id }) else { throw PlaceProblem.notFound }
            places.removeAll { $0.id == id }
            for index in places.indices { places[index].position = index }
            save(places)
        }
    }

    private func load() -> [SavedPlace] {
        guard let data = defaults.data(forKey: Self.storageKey) else { return [Self.boise] }
        let places = (try? StoreJSON.decoder().decode([SavedPlace].self, from: data)) ?? [Self.boise]
        return places.sorted { $0.position < $1.position }
    }

    private func save(_ places: [SavedPlace]) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        if let data = try? encoder.encode(places) { defaults.set(data, forKey: Self.storageKey) }
    }
}

/// The bundled Idaho places the person picks from (Resources/Fixtures/idaho-places.json).
enum IdahoPlaces {
    static let fixtureName = "idaho-places"

    static func decode(_ data: Data) throws -> [PlaceCandidate] {
        try JSONDecoder().decode([PlaceCandidate].self, from: data)
    }
}

/// Pro, as a local stub only: no StoreKit, no paywall. `-AQIProStub YES` at launch turns it on.
enum ProStub {
    static let launchKey = "AQIProStub"

    static func isOn(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: launchKey)
    }
}

/// The places list: saved places, which one is active, and what the person may do next.
@MainActor
@Observable
final class PlacesModel {
    enum State: Equatable {
        case loading
        case loaded
        case failed
    }

    private(set) var state: State = .loading
    private(set) var places: [SavedPlace] = []
    private(set) var activeId: String?
    /// The last refusal, for the screen to show. Cleared by the next change that works.
    private(set) var problem: PlaceProblem?

    let candidates: [PlaceCandidate]
    /// Follows the person's plan (ProModel): buying Pro on the paywall opens more places at once.
    var isPro: Bool
    private let provider: any SavedPlacesProvider
    private let defaults: UserDefaults
    private let now: @Sendable () -> Date

    static let activeKey = "places.active.v1"

    init(
        provider: any SavedPlacesProvider,
        candidates: [PlaceCandidate],
        isPro: Bool,
        defaults: UserDefaults = .standard,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.provider = provider
        self.candidates = candidates
        self.isPro = isPro
        self.defaults = defaults
        self.now = now
        activeId = defaults.string(forKey: Self.activeKey)
    }

    /// How many places this person may keep: 5 with Pro, 1 on Free.
    var allowance: Int { isPro ? PlaceLimits.maxSaved : PlaceLimits.freeSaved }
    var isAtCap: Bool { places.count >= PlaceLimits.maxSaved }
    /// Adding would pass the Free allowance but not the cap.
    var addNeedsPro: Bool { !isAtCap && places.count >= allowance }
    var canAdd: Bool { places.count < allowance }

    /// The active place: the stored choice when it is still saved and allowed, else the first place.
    var active: SavedPlace? {
        if let activeId, let place = places.first(where: { $0.id == activeId }), canActivate(place) { return place }
        return places.first
    }

    /// Candidates not already saved.
    var addable: [PlaceCandidate] {
        candidates.filter { candidate in !places.contains { $0.name == candidate.name && $0.latitude == candidate.latitude } }
    }

    /// On Free only the first place in the list can be active; the rest are Pro.
    func canActivate(_ place: SavedPlace) -> Bool {
        isPro || places.first?.id == place.id
    }

    /// The active place as the home screen uses it, with its local time zone.
    var activePlace: Place? {
        active.map(place(for:))
    }

    func place(for saved: SavedPlace) -> Place {
        let match = candidates.first { $0.name == saved.name && $0.latitude == saved.latitude } ??
            candidates.first { $0.latitude == saved.latitude && $0.longitude == saved.longitude }
        let zone = match.flatMap { TimeZone(identifier: $0.timeZone) } ?? TimeZone(identifier: "America/Boise")!
        return Place(id: saved.id, name: saved.name, region: match?.region ?? "Idaho", timeZone: zone)
    }

    func load() async {
        do {
            places = try await provider.list()
            state = .loaded
        } catch {
            state = .failed
        }
    }

    @discardableResult
    func add(_ candidate: PlaceCandidate) async -> Bool {
        if isAtCap { problem = .atCap; return false }
        if !canAdd { problem = .needsPro; return false }
        do {
            let place = try await provider.add(candidate, now: now())
            places.append(place)
            problem = nil
            return true
        } catch let refused as PlaceProblem {
            problem = refused
            return false
        } catch {
            problem = nil
            state = .failed
            return false
        }
    }

    @discardableResult
    func rename(_ id: String, to raw: String) async -> Bool {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { problem = .emptyName; return false }
        if name.count > PlaceLimits.nameMax { problem = .nameTooLong; return false }
        do {
            let renamed = try await provider.rename(id: id, to: name)
            if let index = places.firstIndex(where: { $0.id == id }) { places[index] = renamed }
            problem = nil
            return true
        } catch let refused as PlaceProblem {
            problem = refused
            return false
        } catch {
            state = .failed
            return false
        }
    }

    /// Deleting the active place makes the first remaining one active. Deleting the last leaves none.
    @discardableResult
    func delete(_ id: String) async -> Bool {
        do {
            try await provider.delete(id: id)
            places.removeAll { $0.id == id }
            for index in places.indices { places[index].position = index }
            if activeId == id { setActive(nil) }
            problem = nil
            return true
        } catch let refused as PlaceProblem {
            problem = refused
            return false
        } catch {
            state = .failed
            return false
        }
    }

    @discardableResult
    func activate(_ id: String) -> Bool {
        guard let place = places.first(where: { $0.id == id }) else { problem = .notFound; return false }
        guard canActivate(place) else { problem = .needsPro; return false }
        setActive(id)
        problem = nil
        return true
    }

    private func setActive(_ id: String?) {
        activeId = id
        if let id { defaults.set(id, forKey: Self.activeKey) } else { defaults.removeObject(forKey: Self.activeKey) }
    }
}
