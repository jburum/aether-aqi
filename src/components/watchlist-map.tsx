import { useEffect, useMemo, useRef, useState } from "react";
import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  LngLatBounds,
  setWorkerUrl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LocateFixed, X } from "lucide-react";
import { aqiHex, formatAqi, getAqiMeta } from "@/lib/aqi";
import { fetchAirQuality } from "@/lib/open-meteo";
import { useLocationsStore } from "@/lib/locations-store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Stable public path: worker ESM imports ./maplibre-gl-shared.mjs alongside it.
// (Vite hashed ?url breaks the relative shared import → black map.)
setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

// button look for router links (Button has no asChild)
const linkBtn =
  "inline-flex h-9 items-center justify-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface-2 px-3 text-xs font-medium text-fg transition-opacity hover:border-border-strong active:scale-[0.98]";

/** Free dark basemap — no API key (Carto Dark Matter via MapLibre style). */
const MAP_STYLE =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

function makeMarkerEl(aqi: number | null, selected: boolean): HTMLButtonElement {
  const meta = getAqiMeta(aqi);
  const color = aqiHex(meta.token);
  const el = document.createElement("button");
  el.type = "button";
  el.className = "aqi-map-marker";
  el.setAttribute("aria-label", `AQI ${formatAqi(aqi)}, ${meta.label}`);
  el.innerHTML = `<span class="aqi-map-marker-value">${formatAqi(aqi)}</span>`;
  el.style.setProperty("--aqi-marker", color);
  if (selected) el.dataset.selected = "1";
  return el;
}

export function WatchlistMap() {
  const locations = useLocationsStore((s) => s.locations);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<InstanceType<typeof MapLibreMap> | null>(null);
  const markersRef = useRef<Map<string, InstanceType<typeof Marker>>>(new Map());
  const [mapReady, setMapReady] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);

  const queries = useQueries({
    queries: locations.map((loc) => ({
      queryKey: ["aqi", loc.id, loc.latitude, loc.longitude],
      queryFn: () => fetchAirQuality(loc.latitude, loc.longitude),
      staleTime: 5 * 60 * 1000,
      refetchInterval: 15 * 60 * 1000,
      retry: 2,
      networkMode: "always" as const,
    })),
  });

  const points = useMemo(
    () =>
      locations.map((loc, i) => ({
        loc,
        aqi: queries[i]?.data?.current.us_aqi ?? null,
        isLoading: queries[i]?.isLoading || queries[i]?.isFetching,
        mainPollutant: queries[i]?.data?.mainPollutant,
      })),
    [locations, queries],
  );

  const selected = points.find((p) => p.loc.id === selectedId) ?? null;

  // Init map once
  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;

    const map = new MapLibreMap({
      container: el,
      style: MAP_STYLE,
      center: [-114.5, 44.0],
      zoom: 5,
      attributionControl: { compact: true },
    });
    // Bottom-right so +/− never collide with Locate (top-right toolbar)
    map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    mapRef.current = map;
    map.on("load", () => {
      setMapReady(true);
      // Ensure canvas has a real size after layout (iOS Safari flex)
      map.resize();
    });
    map.on("error", (e) => {
      console.error("[map]", e.error ?? e);
    });

    const onResize = () => map.resize();
    window.addEventListener("resize", onResize);
    // One more resize after paint
    const t = window.setTimeout(() => map.resize(), 100);

    return () => {
      window.clearTimeout(t);
      window.removeEventListener("resize", onResize);
      for (const m of markersRef.current.values()) m.remove();
      markersRef.current.clear();
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  // Sync markers to locations + AQI
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const seen = new Set<string>();

    for (const { loc, aqi } of points) {
      seen.add(loc.id);
      const existing = markersRef.current.get(loc.id);
      if (!existing) {
        const btn = makeMarkerEl(aqi, selectedId === loc.id);
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          setSelectedId(loc.id);
        });
        const created = new Marker({ element: btn, anchor: "center" })
          .setLngLat([loc.longitude, loc.latitude])
          .addTo(map);
        markersRef.current.set(loc.id, created);
      } else {
        existing.setLngLat([loc.longitude, loc.latitude]);
        const btn = existing.getElement() as HTMLButtonElement;
        const meta = getAqiMeta(aqi);
        btn.style.setProperty("--aqi-marker", aqiHex(meta.token));
        const val = btn.querySelector(".aqi-map-marker-value");
        if (val) val.textContent = formatAqi(aqi);
        btn.setAttribute("aria-label", `AQI ${formatAqi(aqi)}, ${meta.label}`);
        if (selectedId === loc.id) btn.dataset.selected = "1";
        else delete btn.dataset.selected;
      }
    }

    for (const [id, marker] of markersRef.current) {
      if (!seen.has(id)) {
        marker.remove();
        markersRef.current.delete(id);
      }
    }
  }, [points, mapReady, selectedId]);

  // Fit bounds when location set changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || locations.length === 0) return;

    if (locations.length === 1) {
      map.easeTo({
        center: [locations[0].longitude, locations[0].latitude],
        zoom: 8,
        duration: 600,
      });
      return;
    }

    const bounds = new LngLatBounds();
    for (const loc of locations) {
      bounds.extend([loc.longitude, loc.latitude]);
    }
    map.fitBounds(bounds, {
      padding: { top: 72, bottom: 160, left: 48, right: 48 },
      maxZoom: 9,
      duration: 700,
    });
  }, [locations, mapReady]);

  // Pan to selected
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selected) return;
    map.easeTo({
      center: [selected.loc.longitude, selected.loc.latitude],
      duration: 450,
    });
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps -- pan only on id change

  function locateMe() {
    setGeoError(null);
    if (!navigator.geolocation) {
      setGeoError("Location not available");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        mapRef.current?.easeTo({
          center: [pos.coords.longitude, pos.coords.latitude],
          zoom: 9,
          duration: 700,
        });
      },
      () => setGeoError("Could not get location"),
      { enableHighAccuracy: true, timeout: 12_000 },
    );
  }

  const meta = selected ? getAqiMeta(selected.aqi) : null;

  return (
    <div className="aqi-map-page relative flex min-h-0 flex-1 flex-col">
      <div className="aqi-map-toolbar pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-3 pt-[max(0.5rem,env(safe-area-inset-top,0px))]">
        <div className="pointer-events-auto rounded-xl border border-border bg-bg/90 px-3 py-2 shadow-lg backdrop-blur-md">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted">
            Map
          </p>
          <p className="text-sm text-fg">
            {locations.length} place{locations.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="pointer-events-auto flex flex-col items-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={locateMe}
            aria-label="Locate me"
            className="shadow-lg"
          >
            <LocateFixed className="size-4" />
            Locate
          </Button>
          {geoError && (
            <span className="max-w-[10rem] rounded-md bg-surface-2 px-2 py-1 text-xs text-aqi-unhealthy">
              {geoError}
            </span>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        className="aqi-map-canvas absolute inset-0 bottom-[calc(3.75rem+env(safe-area-inset-bottom,0px))]"
      />

      {locations.length === 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg/60 p-6 backdrop-blur-sm">
          <div className="max-w-sm rounded-2xl border border-border bg-surface p-6 text-center shadow-xl">
            <p className="font-medium">No places yet</p>
            <p className="mt-1 text-sm text-muted">
              Add locations on the List tab — they show here as AQI pins.
            </p>
            <Link to="/" className={cn(linkBtn, "mt-4 bg-accent text-accent-fg border-transparent")}>
              Go to list
            </Link>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="pointer-events-none absolute bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] left-3 z-10 hidden sm:block">
        <div className="pointer-events-auto rounded-xl border border-border bg-bg/90 px-3 py-2 text-[10px] shadow-lg backdrop-blur-md">
          <div className="mb-1 font-medium uppercase tracking-wider text-muted">
            US AQI
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ["good", "0–50"],
                ["moderate", "51–100"],
                ["usg", "101–150"],
                ["unhealthy", "151+"],
              ] as const
            ).map(([token, range]) => (
              <span key={token} className="inline-flex items-center gap-1 text-subtle">
                <span
                  className="inline-block size-2.5 rounded-full"
                  style={{ background: aqiHex(token) }}
                />
                {range}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Detail sheet */}
      {selected && meta && (
        <div
          className={cn(
            "absolute inset-x-0 z-20 mx-auto max-w-lg px-3",
            "bottom-[calc(4.25rem+env(safe-area-inset-bottom,0px))]",
          )}
        >
          <div className="rounded-2xl border border-border bg-surface p-4 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{selected.loc.name}</p>
                <p className="mt-0.5 text-xs text-subtle">
                  {selected.loc.latitude.toFixed(2)}°,{" "}
                  {selected.loc.longitude.toFixed(2)}°
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="mt-3 flex items-end justify-between gap-3">
              <div>
                <p
                  className="text-4xl font-semibold tabular tracking-tight"
                  style={{ color: aqiHex(meta.token) }}
                >
                  {formatAqi(selected.aqi)}
                </p>
                <p className="mt-0.5 text-sm font-medium" style={{ color: aqiHex(meta.token) }}>
                  {meta.label}
                </p>
              </div>
              <div className="text-right text-xs text-muted">
                <p>US AQI</p>
                {selected.mainPollutant && selected.mainPollutant !== "—" && (
                  <p className="mt-1 text-subtle">Main: {selected.mainPollutant}</p>
                )}
              </div>
            </div>
            <p className="mt-3 text-sm text-muted">{meta.advice}</p>
            <Link to="/" className={cn(linkBtn, "mt-4 w-full")}>
              Open in list
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
