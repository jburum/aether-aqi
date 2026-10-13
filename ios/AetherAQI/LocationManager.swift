import CoreLocation

@MainActor
final class LocationManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var coordinate: CLLocationCoordinate2D?
    @Published var status: CLAuthorizationStatus = .notDetermined
    @Published var placeName: String?
    private let mgr = CLLocationManager()

    override init() {
        super.init()
        mgr.delegate = self
        mgr.desiredAccuracy = kCLLocationAccuracyKilometer
        status = mgr.authorizationStatus
    }

    func request() {
        if mgr.authorizationStatus == .notDetermined { mgr.requestWhenInUseAuthorization() } else { mgr.requestLocation() }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        Task { @MainActor in
            status = m.authorizationStatus
            if status == .authorizedWhenInUse || status == .authorizedAlways { mgr.requestLocation() }
        }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didUpdateLocations locs: [CLLocation]) {
        guard let loc = locs.last else { return }
        Task { @MainActor in
            coordinate = loc.coordinate
            if let p = try? await CLGeocoder().reverseGeocodeLocation(loc).first {
                placeName = [p.locality, p.administrativeArea].compactMap { $0 }.joined(separator: ", ")
            }
        }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {}
}
