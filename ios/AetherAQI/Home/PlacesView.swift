import SwiftUI

/// Opens the places list from anywhere on the home screen (the place name, the empty state).
/// Nil where there is no places list (still renders, tests).
private struct OpenPlacesKey: EnvironmentKey {
    static let defaultValue: (@MainActor () -> Void)? = nil
}

extension EnvironmentValues {
    var openPlaces: (@MainActor () -> Void)? {
        get { self[OpenPlacesKey.self] }
        set { self[OpenPlacesKey.self] = newValue }
    }
}

/// Saved places: pick the active one, rename, delete, and add from the bundled Idaho list.
/// Up to 5 places; on Free only the first. No paywall: Pro is a local stub flag.
struct PlacesView: View {
    let places: PlacesModel
    /// The person's plan. With it, adding a second place on Free opens the paywall.
    var pro: ProModel? = nil
    let done: () -> Void
    @State private var renaming: SavedPlace?
    @State private var newName = ""
    @State private var adding = false
    @State private var showingPaywall = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(places.places) { place in
                        row(place)
                    }
                } header: {
                    Text("Your places")
                } footer: {
                    Text(countLine)
                }

                Section {
                    addRow
                    if let problem = places.problem {
                        Text(problem.message)
                            .foregroundStyle(.secondary)
                            .accessibilityAddTraits(.updatesFrequently)
                    }
                }
            }
            .navigationTitle("Places")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done", action: done) }
            }
            .sheet(isPresented: $adding) {
                AddPlaceView(places: places) { adding = false }
            }
            .sheet(isPresented: $showingPaywall) {
                if let pro {
                    PaywallView(pro: pro, reason: .places) {
                        showingPaywall = false
                        // Bought on the paywall: the second place opens at once.
                        places.isPro = pro.isPro
                    }
                }
            }
            .alert("Rename place", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Name", text: $newName)
                Button("Save") {
                    if let id = renaming?.id {
                        let name = newName
                        Task { await places.rename(id, to: name) }
                    }
                    renaming = nil
                }
                Button("Cancel", role: .cancel) { renaming = nil }
            } message: {
                Text("Up to \(PlaceLimits.nameMax) characters.")
            }
        }
    }

    private var countLine: String {
        "\(places.places.count) of \(PlaceLimits.maxSaved) places" + (places.isPro ? "" : ". Free includes one.")
    }

    @ViewBuilder private func row(_ place: SavedPlace) -> some View {
        let isActive = places.active?.id == place.id
        let allowed = places.canActivate(place)
        Button {
            places.activate(place.id)
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(place.name)
                    if let valley = place.valley {
                        Text(valley).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if isActive {
                    Image(systemName: "checkmark").accessibilityHidden(true)
                } else if !allowed {
                    Text("Pro").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(place.name)\(isActive ? ", showing on home" : allowed ? "" : ", needs Pro")")
        .accessibilityAddTraits(isActive ? .isSelected : [])
        .swipeActions(edge: .trailing) {
            Button("Delete", role: .destructive) { Task { await places.delete(place.id) } }
        }
        .swipeActions(edge: .leading) {
            Button("Rename") {
                newName = place.name
                renaming = place
            }
        }
        .contextMenu {
            Button("Rename") {
                newName = place.name
                renaming = place
            }
            Button("Delete", role: .destructive) { Task { await places.delete(place.id) } }
        }
    }

    @ViewBuilder private var addRow: some View {
        if places.isAtCap {
            // At the cap: the button stays visible but cannot be used, and says why.
            Label("Add a place", systemImage: "plus")
                .foregroundStyle(.secondary)
                .accessibilityHint(PlaceProblem.atCap.message)
            Text(PlaceProblem.atCap.message)
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else if places.addNeedsPro {
            if pro != nil {
                Button {
                    showingPaywall = true
                } label: {
                    Label("Add a place with Pro", systemImage: "lock")
                }
                .accessibilityHint(PlaceProblem.needsPro.message)
            } else {
                Label("Add a place", systemImage: "lock")
                    .foregroundStyle(.secondary)
                    .accessibilityHint(PlaceProblem.needsPro.message)
            }
            Text(PlaceProblem.needsPro.message)
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else {
            Button {
                adding = true
            } label: {
                Label("Add a place", systemImage: "plus")
            }
        }
    }
}

/// The bundled Idaho list, minus places already saved. No geocoding, no location permission.
private struct AddPlaceView: View {
    let places: PlacesModel
    let done: () -> Void
    @State private var query = ""

    private var shown: [PlaceCandidate] {
        let all = places.addable
        let text = query.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? all : all.filter { $0.name.localizedCaseInsensitiveContains(text) || ($0.valley ?? "").localizedCaseInsensitiveContains(text) }
    }

    var body: some View {
        NavigationStack {
            List(shown) { candidate in
                Button {
                    Task {
                        if await places.add(candidate) { done() }
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(candidate.name)
                        Text([candidate.valley, candidate.region].compactMap { $0 }.joined(separator: ", "))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .overlay {
                if shown.isEmpty { Text("No Idaho places match.").foregroundStyle(.secondary) }
            }
            .searchable(text: $query, prompt: "Idaho places")
            .navigationTitle("Add a place")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: done) }
            }
        }
    }
}
