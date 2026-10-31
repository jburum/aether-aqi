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

    private(set) var state: State = .loading
    private(set) var timelineState: TimelineState = .loading
    /// The lead hour (0–48 from the cycle's issue time) the timeline is on.
    private(set) var selectedLead: Int = 0
    /// True while a finger is on the timeline. The field color holds still until release (design/round2.html).
    var isScrubbing = false

    private let provider: any AirDataProvider
    private let now: @Sendable () -> Date

    init(provider: any AirDataProvider, now: @escaping @Sendable () -> Date = { Date() }) {
        self.provider = provider
        self.now = now
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
        state = .loading
        timelineState = .loading
        settleLevel()
        do {
            if let snapshot = try await provider.homeSnapshot() {
                state = .loaded(snapshot)
                settleLevel()
                await loadTimeline(for: snapshot.place)
            } else {
                state = .empty
                timelineState = .empty
            }
        } catch is CancellationError {
            // The view went away; keep whatever is on screen.
        } catch {
            // Never leave an old number up as if it were current.
            state = .failed
            timelineState = .failed
        }
        settleLevel()
    }

    /// Retries the timeline alone; the current number stays up.
    func reloadTimeline() async {
        guard case .loaded(let snapshot) = state else { return }
        timelineState = .loading
        settleLevel()
        await loadTimeline(for: snapshot.place)
        settleLevel()
    }

    private func loadTimeline(for place: Place) async {
        selectableLeads = nil
        nowLead = nil
        selectedLead = 0
        do {
            let rows = try await provider.hourlyForecast(for: place)
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
