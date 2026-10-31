import Foundation
import Observation

/// Drives the Free home screen: loading, the air for one place, no place yet, or a failed load, plus the
/// 48-hour timeline and the hour the user has dragged to.
@MainActor
@Observable
final class HomeModel {
    enum State: Equatable {
        case loading
        case loaded(HomeSnapshot)
        case empty
        case failed
    }

    enum TimelineState: Equatable {
        case loading
        case loaded(ForecastTimeline)
        /// No forecast rows for this place.
        case empty
        /// The newest cycle no longer covers the current hour.
        case outdated
        case failed
    }

    /// What the hero shows for the selected hour.
    enum Selection: Equatable {
        /// The selected hour has our forecast.
        case forecast(ForecastTimeline.Slot, isNow: Bool)
        /// NOAA left this hour empty. No number is shown for it.
        case missing(ForecastTimeline.Slot, isNow: Bool)
    }

    /// A part of the screen that loads on its own: the best window, the outlook.
    enum PartState<Value: Equatable>: Equatable {
        case loading
        case loaded(Value)
        case failed
    }

    private(set) var state: State = .loading
    private(set) var timelineState: TimelineState = .loading
    private(set) var bestWindowState: PartState<BestWindowDisplay> = .loading
    private(set) var outlookState: PartState<OutlookDisplay> = .loading
    private(set) var alertsState: PartState<AlertsDisplay> = .loading
    /// The lead hour (0–48 from the cycle's issue time) the timeline is on.
    private(set) var selectedLead: Int = 0
    /// True while a finger is on the timeline. The field color holds still until release (design/round2.html).
    var isScrubbing = false

    private let provider: any AirDataProvider
    private let now: @Sendable () -> Date
    /// The active saved place the screen shows. Nil (no saved place) is the empty state.
    private(set) var place: Place?

    init(provider: any AirDataProvider, now: @escaping @Sendable () -> Date = { Date() }, place: Place? = SampleAirProvider.boise) {
        self.provider = provider
        self.now = now
        self.place = place
    }

    /// The home screen follows the active place: switching reloads every section for the new one.
    func show(_ next: Place?) async {
        // The same place, already loaded or loading: nothing to do. A first show or a failed one loads.
        if next == place, started, state != .failed { return }
        place = next
        await load()
    }

    /// A load has begun at least once.
    private var started = false

    /// The place line (the way into the places list) for every state that doesn't draw its own:
    /// loading, a stalled load, an error, or no air yet. A loaded screen shows it inside the content.
    /// Nil only when there is no place at all; that empty state has its own "Add a place" button.
    var placeLineOutsideContent: Place? {
        if case .loaded = state { return nil }
        return place
    }

    /// The hours the user can drag through: the current hour through the 48-hour lead.
    private(set) var selectableLeads: ClosedRange<Int>?
    private(set) var nowLead: Int?

    var timeline: ForecastTimeline? {
        if case .loaded(let timeline) = timelineState { timeline } else { nil }
    }

    var selection: Selection? {
        guard let timeline, timeline.slots.indices.contains(selectedLead) else { return nil }
        let slot = timeline.slots[selectedLead]
        let isNow = selectedLead == nowLead
        return slot.aqi == nil ? .missing(slot, isNow: isNow) : .forecast(slot, isNow: isNow)
    }

    /// The level shown on screen: the selected hour once the timeline is in, else the current number.
    /// Nil for the neutral field (loading, empty, error, or an hour with no forecast).
    var shownLevel: AirLevel? {
        guard case .loaded(let snapshot) = state else { return nil }
        switch selection {
        case .forecast(let slot, _): return slot.level
        case .missing: return nil
        case nil: return snapshot.now.level
        }
    }

    /// The level that tints the whole app. It follows the selected hour, but holds while dragging.
    private(set) var level: AirLevel?

    func load() async {
        started = true
        state = .loading
        timelineState = .loading
        settleLevel()
        guard let place else {
            state = .empty
            timelineState = .empty
            settleLevel()
            return
        }
        do {
            let loaded = try await provider.homeSnapshot(for: place)
            // The person switched places while this was loading: the newer load owns the screen.
            guard isCurrent(place) else { return }
            if let snapshot = loaded {
                state = .loaded(snapshot)
                settleLevel()
                await loadSections(for: snapshot.place)
            } else {
                state = .empty
                timelineState = .empty
            }
        } catch is CancellationError {
            // The view went away; keep whatever is on screen.
        } catch {
            guard isCurrent(place) else { return }
            // Never leave an old number up as if it were current.
            state = .failed
            timelineState = .failed
        }
        settleLevel()
    }

    /// A result for `place` may still land: it is the place on screen.
    private func isCurrent(_ place: Place) -> Bool {
        self.place == place
    }

    /// Retries the timeline alone; the current number stays up.
    func reloadTimeline() async {
        guard case .loaded(let snapshot) = state else { return }
        timelineState = .loading
        settleLevel()
        await loadTimeline(for: snapshot.place)
        settleLevel()
    }

    /// Retries the best window and the outlook; the rest of the screen stays up. Each still publishes
    /// as soon as its own answer arrives.
    func reloadWindowAndOutlook() async {
        guard case .loaded(let snapshot) = state else { return }
        let place = snapshot.place
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.loadBestWindow(for: place) }
            group.addTask { await self.loadOutlook(for: place) }
        }
    }

    /// The timeline, best window, outlook and alerts start together, and each publishes the moment its
    /// own request finishes. A stalled or failed one never holds back the others (Dex, PR 14 at 05abf90).
    private func loadSections(for place: Place) async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                await self.loadTimeline(for: place)
                await self.settleLevel()
            }
            group.addTask { await self.loadBestWindow(for: place) }
            group.addTask { await self.loadOutlook(for: place) }
            group.addTask { await self.loadAlerts(for: place) }
        }
    }

    /// Retries the alerts alone; everything else stays up.
    func reloadAlerts() async {
        guard case .loaded(let snapshot) = state else { return }
        await loadAlerts(for: snapshot.place)
    }

    private func loadAlerts(for place: Place) async {
        alertsState = .loading
        let provider = provider
        let result = await Self.attempt({ try await provider.alerts(for: place) })
        guard isCurrent(place) else { return }
        switch result {
        case .success(let response): alertsState = .loaded(AlertsDisplay(response, fallbackZone: place.timeZone))
        case .failure(let error) where error is CancellationError: break
        case .failure: alertsState = .failed
        }
    }

    private func loadBestWindow(for place: Place) async {
        bestWindowState = .loading
        let provider = provider
        let result = await Self.attempt({ try await provider.bestWindow(for: place) })
        guard isCurrent(place) else { return }
        switch result {
        case .success(let response): bestWindowState = .loaded(BestWindowDisplay(response, place: place))
        case .failure(let error) where error is CancellationError: break
        case .failure: bestWindowState = .failed
        }
    }

    private func loadOutlook(for place: Place) async {
        outlookState = .loading
        let provider = provider
        let result = await Self.attempt({ try await provider.outlook(for: place) })
        guard isCurrent(place) else { return }
        switch result {
        case .success(let response): outlookState = .loaded(OutlookDisplay(response, fallbackZone: place.timeZone))
        case .failure(let error) where error is CancellationError: break
        case .failure: outlookState = .failed
        }
    }

    private nonisolated static func attempt<T: Sendable>(_ body: @Sendable () async throws -> T) async -> Result<T, Error> {
        do {
            return .success(try await body())
        } catch {
            return .failure(error)
        }
    }

    private func loadTimeline(for place: Place) async {
        selectableLeads = nil
        nowLead = nil
        selectedLead = 0
        do {
            let rows = try await provider.hourlyForecast(for: place)
            guard isCurrent(place) else { return }
            guard let timeline = ForecastTimeline(rows: rows) else {
                timelineState = .empty
                return
            }
            let current = now()
            guard let range = timeline.selectableLeads(now: current) else {
                timelineState = .outdated
                return
            }
            selectableLeads = range
            nowLead = timeline.lead(at: current)
            selectedLead = nowLead ?? range.lowerBound
            timelineState = .loaded(timeline)
        } catch is CancellationError {
        } catch {
            guard isCurrent(place) else { return }
            timelineState = .failed
        }
    }

    /// Moves the selection to `lead`, clamped to the selectable hours. Returns true when it changed.
    @discardableResult
    func select(lead: Int) -> Bool {
        guard let range = selectableLeads, timeline != nil else { return false }
        let clamped = min(max(lead, range.lowerBound), range.upperBound)
        guard clamped != selectedLead else { return false }
        selectedLead = clamped
        if !isScrubbing { settleLevel() }
        return true
    }

    /// One hour later (positive) or earlier (negative), as VoiceOver's adjustable action does.
    @discardableResult
    func step(by hours: Int) -> Bool {
        select(lead: selectedLead + hours)
    }

    func selectNow() {
        if let nowLead { select(lead: nowLead) }
    }

    func beginScrub() {
        isScrubbing = true
    }

    /// Finger up: the field crossfades to the selected hour's level.
    func endScrub() {
        isScrubbing = false
        settleLevel()
    }

    private func settleLevel() {
        level = shownLevel
    }
}
