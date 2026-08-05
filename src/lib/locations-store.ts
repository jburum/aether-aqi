import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface TrackedLocation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  /**
   * Optional alert threshold (US AQI). Used by Phase 2 notifications:
   * notify when current AQI meets/exceeds this value. Stored per device.
   */
  alertAt: number | null;
}

const MAX_LOCATIONS = 5;

const DEFAULTS: TrackedLocation[] = [
  {
    id: "mccall-id",
    name: "McCall, Idaho",
    latitude: 44.911,
    longitude: -116.098,
    alertAt: 100,
  },
  {
    id: "boise-id",
    name: "Boise, Idaho",
    latitude: 43.615,
    longitude: -116.202,
    alertAt: 100,
  },
  {
    id: "slc-ut",
    name: "Salt Lake City, Utah",
    latitude: 40.761,
    longitude: -111.891,
    alertAt: 100,
  },
  {
    id: "la-ca",
    name: "Los Angeles, California",
    latitude: 34.052,
    longitude: -118.244,
    alertAt: 100,
  },
];

interface LocationsState {
  locations: TrackedLocation[];
  selectedId: string | null;
  addLocation: (
    loc: Omit<TrackedLocation, "id" | "alertAt"> & { alertAt?: number | null },
  ) => boolean;
  removeLocation: (id: string) => void;
  updateLocation: (id: string, patch: Partial<TrackedLocation>) => void;
  selectLocation: (id: string | null) => void;
  canAdd: () => boolean;
}

function uid() {
  return `loc_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Device-local watchlist. Persists to localStorage under a stable key so
 * existing installs keep their lists. Not synced across devices/browsers.
 */
export const useLocationsStore = create<LocationsState>()(
  persist(
    (set, get) => ({
      locations: DEFAULTS,
      // Cards start collapsed; tap expands in place.
      selectedId: null,
      canAdd: () => get().locations.length < MAX_LOCATIONS,
      addLocation: (loc) => {
        const { locations } = get();
        if (locations.length >= MAX_LOCATIONS) return false;
        const exists = locations.some(
          (l) =>
            Math.abs(l.latitude - loc.latitude) < 0.02 &&
            Math.abs(l.longitude - loc.longitude) < 0.02,
        );
        if (exists) return false;
        const next: TrackedLocation = {
          id: uid(),
          name: loc.name,
          latitude: loc.latitude,
          longitude: loc.longitude,
          alertAt: loc.alertAt ?? 100,
        };
        set({ locations: [...locations, next], selectedId: next.id });
        return true;
      },
      removeLocation: (id) => {
        const locations = get().locations.filter((l) => l.id !== id);
        const selectedId =
          get().selectedId === id ? null : get().selectedId;
        set({ locations, selectedId });
      },
      updateLocation: (id, patch) => {
        set({
          locations: get().locations.map((l) => (l.id === id ? { ...l, ...patch } : l)),
        });
      },
      selectLocation: (id) => set({ selectedId: id }),
    }),
    {
      // Keep key stable — renaming would drop users' saved locations.
      name: "aether-locations-v1",
      partialize: (s) => ({ locations: s.locations, selectedId: s.selectedId }),
    },
  ),
);

export { MAX_LOCATIONS };
