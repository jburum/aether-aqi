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

const MAX_LOCATIONS = 15;

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
  /** Returns new location id, or null if not added. Does not auto-expand. */
  addLocation: (
    loc: Omit<TrackedLocation, "id" | "alertAt"> & { alertAt?: number | null },
  ) => string | null;
  removeLocation: (id: string) => void;
  updateLocation: (id: string, patch: Partial<TrackedLocation>) => void;
  selectLocation: (id: string | null) => void;
  /** Move `activeId` so it sits at the index currently held by `overId`. */
  reorderLocations: (activeId: string, overId: string) => void;
  canAdd: () => boolean;
}

function uid() {
  return `loc_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Device-local watchlist. Persists to localStorage under a stable key so
 * existing installs keep their lists. Not synced across devices/browsers.
 * Order of `locations` is the display order (drag-to-reorder).
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
        if (locations.length >= MAX_LOCATIONS) return null;
        const exists = locations.some(
          (l) =>
            Math.abs(l.latitude - loc.latitude) < 0.02 &&
            Math.abs(l.longitude - loc.longitude) < 0.02,
        );
        if (exists) return null;
        const next: TrackedLocation = {
          id: uid(),
          name: loc.name,
          latitude: loc.latitude,
          longitude: loc.longitude,
          alertAt: loc.alertAt ?? 100,
        };
        // Keep selectedId unchanged so the list doesn't jump/expand and
        // push the header off-screen on mobile after adding.
        set({ locations: [...locations, next] });
        return next.id;
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
      reorderLocations: (activeId, overId) => {
        if (activeId === overId) return;
        const list = [...get().locations];
        const from = list.findIndex((l) => l.id === activeId);
        const to = list.findIndex((l) => l.id === overId);
        if (from < 0 || to < 0) return;
        const [item] = list.splice(from, 1);
        list.splice(to, 0, item);
        set({ locations: list });
      },
    }),
    {
      // Keep key stable — renaming would drop users' saved locations.
      name: "aether-locations-v1",
      partialize: (s) => ({ locations: s.locations, selectedId: s.selectedId }),
    },
  ),
);

export { MAX_LOCATIONS };
