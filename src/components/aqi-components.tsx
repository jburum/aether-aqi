import { useMemo, useState, useEffect, useCallback, useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Bell,
  BellOff,
  MapPin,
  Navigation,
  Plus,
  RefreshCw,
  Trash2,
  Wind,
  X,
  Search,
  Loader2,
} from "lucide-react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatAqi, getAqiMeta } from "@/lib/aqi";
import {
  fetchAirQuality,
  placeLabel,
  reverseGeocode,
  searchPlaces,
  type AirQualityPayload,
  type GeoResult,
} from "@/lib/open-meteo";
import {
  MAX_LOCATIONS,
  useLocationsStore,
  type TrackedLocation,
} from "@/lib/locations-store";

function aqiColorClass(token: string) {
  return `aqi-${token}`;
}
function aqiBgClass(token: string) {
  return `bg-aqi-${token}`;
}
function aqiRingClass(token: string) {
  return `ring-aqi-${token}`;
}


export function AetherApp() {
  const locations = useLocationsStore((s) => s.locations);
  const selectedId = useLocationsStore((s) => s.selectedId);
  const selectLocation = useLocationsStore((s) => s.selectLocation);
  const canAdd = useLocationsStore((s) => s.canAdd);
  const [addOpen, setAddOpen] = useState(false);
  const qc = useQueryClient();

  const selected = locations.find((l) => l.id === selectedId) ?? locations[0];

  const queries = useQueries({
    queries: locations.map((loc) => ({
      queryKey: ["aqi", loc.id, loc.latitude, loc.longitude],
      queryFn: () => fetchAirQuality(loc.latitude, loc.longitude),
      staleTime: 5 * 60 * 1000,
      refetchInterval: 15 * 60 * 1000,
    })),
  });

  const refreshing = queries.some((q) => q.isFetching);

  const refreshAll = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["aqi"] });
  }, [qc]);

  // Optional browser notifications when AQI crosses alert threshold
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    for (let i = 0; i < locations.length; i++) {
      const loc = locations[i];
      const data = queries[i]?.data;
      if (!loc || !data || loc.alertAt == null) continue;
      const aqi = data.current.us_aqi;
      if (aqi == null || aqi < loc.alertAt) continue;
      const key = `aether-alerted-${loc.id}-${data.current.time}`;
      if (sessionStorage.getItem(key)) continue;
      sessionStorage.setItem(key, "1");
      const meta = getAqiMeta(aqi);
      try {
        new Notification(`${loc.name}: AQI ${Math.round(aqi)}`, {
          body: `${meta.label}. ${meta.advice}`,
          icon: "/icon-192.png",
          tag: `aether-${loc.id}`,
        });
      } catch {
        /* ignore */
      }
    }
  }, [locations, queries]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-16 pt-6 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-muted">
            <Wind className="size-4" />
            <span className="text-xs font-medium uppercase tracking-[0.14em]">Aether</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Air quality watchlist</h1>
          <p className="max-w-xl text-sm text-muted">
            Live US AQI and multi-day forecasts for up to {MAX_LOCATIONS} places. Data from Open-Meteo
            (CAMS). Saved on this device.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={refreshAll}
            disabled={refreshing}
            aria-label="Refresh all locations"
          >
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
            Refresh
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => setAddOpen(true)}
            disabled={!canAdd()}
            title={canAdd() ? "Add a location" : `Limit of ${MAX_LOCATIONS} locations`}
          >
            <Plus className="size-4" />
            Add place
          </Button>
        </div>
      </header>

      {locations.length === 0 ? (
        <EmptyState onAdd={() => setAddOpen(true)} />
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {locations.map((loc, i) => (
              <LocationCard
                key={loc.id}
                location={loc}
                data={queries[i]?.data}
                isLoading={queries[i]?.isLoading}
                isError={queries[i]?.isError}
                selected={selected?.id === loc.id}
                onSelect={() => selectLocation(loc.id)}
              />
            ))}
            {canAdd() && (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="flex min-h-[148px] flex-col items-center justify-center gap-2 rounded-[var(--radius-xl)] border border-dashed border-border bg-surface/40 p-5 text-sm text-muted transition-colors hover:border-border-strong hover:text-fg"
              >
                <Plus className="size-5" />
                Add location
                <span className="text-xs text-subtle">
                  {locations.length}/{MAX_LOCATIONS} used
                </span>
              </button>
            )}
          </section>

          {selected && (
            <DetailPanel
              location={selected}
              queryIndex={locations.findIndex((l) => l.id === selected.id)}
              queries={queries}
            />
          )}
        </>
      )}

      {addOpen && <AddLocationModal onClose={() => setAddOpen(false)} />}
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-[var(--radius-xl)] border border-border bg-surface p-10 text-center">
      <MapPin className="mx-auto mb-3 size-8 text-subtle" />
      <h2 className="text-lg font-medium">No locations yet</h2>
      <p className="mt-1 text-sm text-muted">Add up to {MAX_LOCATIONS} places to track air quality.</p>
      <Button type="button" className="mt-5" onClick={onAdd}>
        <Plus className="size-4" />
        Add first place
      </Button>
    </div>
  );
}

function LocationCard({
  location,
  data,
  isLoading,
  isError,
  selected,
  onSelect,
}: {
  location: TrackedLocation;
  data?: AirQualityPayload & { mainPollutant: string };
  isLoading?: boolean;
  isError?: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const aqi = data?.current.us_aqi ?? null;
  const meta = getAqiMeta(aqi);
  const spark = useMemo(() => {
    if (!data?.hourly) return [];
    const now = Date.now();
    return data.hourly.time
      .map((t, i) => ({ t, v: data.hourly.us_aqi[i] }))
      .filter((p) => {
        const ms = new Date(p.t).getTime();
        return ms >= now - 3600_000 && ms <= now + 24 * 3600_000 && p.v != null;
      })
      .slice(0, 24)
      .map((p) => p.v as number);
  }, [data]);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex flex-col gap-3 rounded-[var(--radius-xl)] border border-border bg-surface p-5 text-left transition-colors",
        "hover:border-border-strong",
        selected && "border-border-strong ring-1 ring-ring/30",
        aqiRingClass(meta.token),
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium leading-snug">{location.name}</p>
          <p className="mt-0.5 text-xs text-subtle">
            {location.latitude.toFixed(2)}°, {location.longitude.toFixed(2)}°
          </p>
        </div>
        {isLoading ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-subtle" />
        ) : isError ? (
          <span className="text-xs text-aqi-unhealthy">Error</span>
        ) : null}
      </div>

      <div className="flex items-end justify-between gap-3">
        <div>
          <p className={cn("text-4xl font-semibold tracking-tight tabular", aqiColorClass(meta.token))}>
            {formatAqi(aqi)}
          </p>
          <p className={cn("mt-1 text-xs font-medium", aqiColorClass(meta.token))}>{meta.label}</p>
        </div>
        <div className="text-right text-xs text-muted">
          <p>US AQI</p>
          {data?.mainPollutant && data.mainPollutant !== "—" && (
            <p className="mt-1 text-subtle">Main: {data.mainPollutant}</p>
          )}
        </div>
      </div>

      {spark.length > 1 && (
        <div className="h-8 w-full opacity-80">
          <Sparkline values={spark} token={meta.token} />
        </div>
      )}
    </button>
  );
}

function Sparkline({ values, token }: { values: number[]; token: string }) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const w = 100;
  const h = 32;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      return `${x},${y}`;
    })
    .join(" ");
  const colorMap: Record<string, string> = {
    good: "var(--color-aqi-good)",
    moderate: "var(--color-aqi-moderate)",
    usg: "var(--color-aqi-usg)",
    unhealthy: "var(--color-aqi-unhealthy)",
    very: "var(--color-aqi-very)",
    hazardous: "var(--color-aqi-hazardous)",
    unknown: "var(--color-aqi-unknown)",
  };
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden>
      <polyline
        fill="none"
        stroke={colorMap[token] ?? colorMap.unknown}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={pts}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function DetailPanel({
  location,
  queryIndex,
  queries,
}: {
  location: TrackedLocation;
  queryIndex: number;
  queries: Array<{ data?: AirQualityPayload & { mainPollutant: string }; isLoading?: boolean; isError?: boolean; isFetching?: boolean }>;
}) {
  const removeLocation = useLocationsStore((s) => s.removeLocation);
  const updateLocation = useLocationsStore((s) => s.updateLocation);
  const q = queries[queryIndex];
  const data = q?.data as (AirQualityPayload & { mainPollutant: string }) | undefined;
  const meta = getAqiMeta(data?.current.us_aqi);
  const [notifState, setNotifState] = useState<NotificationPermission | "unsupported">("default");

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setNotifState("unsupported");
      return;
    }
    setNotifState(Notification.permission);
  }, []);

  const chartData = useMemo(() => {
    if (!data?.hourly) return [];
    return data.hourly.time.map((t, i) => ({
      time: t,
      label: format(parseISO(t), "EEE Ha"),
      short: format(parseISO(t), "Ha"),
      aqi: data.hourly.us_aqi[i],
      pm25: data.hourly.pm2_5[i],
    })).filter((d) => d.aqi != null);
  }, [data]);

  const daily = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const row of chartData) {
      const day = format(parseISO(row.time), "yyyy-MM-dd");
      if (row.aqi == null) continue;
      const arr = map.get(day) ?? [];
      arr.push(row.aqi);
      map.set(day, arr);
    }
    return [...map.entries()].slice(0, 4).map(([day, vals]) => {
      const max = Math.max(...vals);
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      return { day, label: format(parseISO(day), "EEE M/d"), max, avg: Math.round(avg), meta: getAqiMeta(max) };
    });
  }, [chartData]);

  async function enableAlerts() {
    if (!("Notification" in window)) return;
    const perm = await Notification.requestPermission();
    setNotifState(perm);
  }

  return (
    <section className="rounded-[var(--radius-xl)] border border-border bg-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-subtle">Detail</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">{location.name}</h2>
          <p className={cn("mt-2 text-sm font-medium", aqiColorClass(meta.token))}>
            {formatAqi(data?.current.us_aqi)} · {meta.label}
          </p>
          <p className="mt-2 max-w-2xl text-sm text-muted">{meta.advice}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {notifState !== "unsupported" && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void enableAlerts()}
              disabled={notifState === "granted"}
            >
              {notifState === "granted" ? <Bell className="size-4" /> : <BellOff className="size-4" />}
              {notifState === "granted" ? "Alerts on" : "Enable alerts"}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (confirm(`Remove ${location.name}?`)) removeLocation(location.id);
            }}
          >
            <Trash2 className="size-4" />
            Remove
          </Button>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <PollutantStat label="PM2.5" value={data?.current.pm2_5} unit="µg/m³" />
        <PollutantStat label="PM10" value={data?.current.pm10} unit="µg/m³" />
        <PollutantStat label="Ozone" value={data?.current.ozone} unit="µg/m³" />
        <PollutantStat label="NO₂" value={data?.current.nitrogen_dioxide} unit="µg/m³" />
      </div>

      <div className="mt-6">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Hourly forecast (US AQI)</h3>
          <label className="flex items-center gap-2 text-xs text-muted">
            Alert at
            <select
              className="h-9 rounded-[var(--radius-sm)] border border-border bg-surface-2 px-2 text-fg"
              value={location.alertAt ?? ""}
              onChange={(e) =>
                updateLocation(location.id, {
                  alertAt: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            >
              <option value="">Off</option>
              <option value="50">50 Good</option>
              <option value="100">100 Moderate</option>
              <option value="150">150 USG</option>
              <option value="200">200 Unhealthy</option>
            </select>
          </label>
        </div>

        {q?.isLoading ? (
          <div className="h-56 animate-pulse rounded-[var(--radius-lg)] bg-surface-2" />
        ) : chartData.length === 0 ? (
          <p className="text-sm text-muted">Forecast unavailable.</p>
        ) : (
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="aqiFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-aqi-usg)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--color-aqi-usg)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="short"
                  tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={28}
                />
                <YAxis
                  tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={36}
                  domain={[0, "auto"]}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 12,
                    color: "var(--color-fg)",
                    fontSize: 12,
                  }}
                  labelFormatter={(_, payload) => {
                    const p = payload?.[0]?.payload as { label?: string } | undefined;
                    return p?.label ?? "";
                  }}
                  formatter={(value: number) => [`AQI ${Math.round(value)}`, "US AQI"]}
                />
                <Area
                  type="monotone"
                  dataKey="aqi"
                  stroke="var(--color-aqi-usg)"
                  fill="url(#aqiFill)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {daily.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-3 text-sm font-medium">Next days (peak AQI)</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {daily.map((d) => (
              <div
                key={d.day}
                className={cn(
                  "rounded-[var(--radius-lg)] border border-border p-3",
                  aqiBgClass(d.meta.token),
                )}
              >
                <p className="text-xs text-muted">{d.label}</p>
                <p className={cn("mt-1 text-2xl font-semibold tabular", aqiColorClass(d.meta.token))}>
                  {d.max}
                </p>
                <p className="mt-0.5 text-xs text-subtle">avg {d.avg}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="mt-6 text-xs text-subtle">
        Modeled US AQI via Open-Meteo / CAMS. Not a substitute for local regulatory monitors (AirNow)
        during wildfire events — cross-check when smoke is active.
      </p>
    </section>
  );
}

function PollutantStat({
  label,
  value,
  unit,
}: {
  label: string;
  value: number | null | undefined;
  unit: string;
}) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-border bg-surface-2/60 px-3 py-3">
      <p className="text-xs text-subtle">{label}</p>
      <p className="mt-1 text-lg font-medium tabular">
        {value == null ? "—" : value.toFixed(1)}
        <span className="ml-1 text-xs font-normal text-subtle">{unit}</span>
      </p>
    </div>
  );
}

function AddLocationModal({ onClose }: { onClose: () => void }) {
  const addLocation = useLocationsStore((s) => s.addLocation);
  const canAdd = useLocationsStore((s) => s.canAdd);
  const titleId = useId();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      setSearching(true);
      setError(null);
      searchPlaces(q)
        .then(setResults)
        .catch(() => setError("Search failed. Try again."))
        .finally(() => setSearching(false));
    }, 280);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function pick(place: GeoResult) {
    if (!canAdd()) {
      setError(`You already track ${MAX_LOCATIONS} places. Remove one first.`);
      return;
    }
    const ok = addLocation({
      name: placeLabel(place),
      latitude: place.latitude,
      longitude: place.longitude,
    });
    if (!ok) {
      setError("That place is already on your list (or list is full).");
      return;
    }
    onClose();
  }

  async function useMyLocation() {
    if (!navigator.geolocation) {
      setError("Geolocation is not available in this browser.");
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const name = await reverseGeocode(latitude, longitude);
          const ok = addLocation({ name, latitude, longitude });
          if (!ok) setError("Could not add — already tracked or list full.");
          else onClose();
        } catch {
          setError("Could not resolve your location name.");
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
        setError("Location permission denied or unavailable.");
      },
      { enableHighAccuracy: false, timeout: 12000 },
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <div
        className="flex max-h-[90dvh] w-full max-w-md flex-col rounded-t-[var(--radius-xl)] border border-border bg-surface shadow-2xl sm:rounded-[var(--radius-xl)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id={titleId} className="text-base font-semibold">
            Add location
          </h2>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-3 p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search city or place…"
              className="pl-10"
            />
          </div>

          <Button
            type="button"
            variant="secondary"
            className="w-full"
            onClick={() => void useMyLocation()}
            disabled={locating || !canAdd()}
          >
            {locating ? <Loader2 className="size-4 animate-spin" /> : <Navigation className="size-4" />}
            Use my current location
          </Button>

          {error && <p className="text-sm text-aqi-unhealthy">{error}</p>}

          <div className="max-h-64 overflow-y-auto rounded-[var(--radius-lg)] border border-border">
            {searching && (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted">
                <Loader2 className="size-4 animate-spin" /> Searching…
              </div>
            )}
            {!searching && q.trim().length >= 2 && results.length === 0 && (
              <p className="px-3 py-4 text-sm text-muted">No matches.</p>
            )}
            {!searching &&
              results.map((r) => (
                <button
                  key={`${r.id}-${r.latitude}`}
                  type="button"
                  className="flex w-full items-start gap-2 border-b border-border px-3 py-3 text-left text-sm last:border-0 hover:bg-surface-2"
                  onClick={() => pick(r)}
                >
                  <MapPin className="mt-0.5 size-4 shrink-0 text-subtle" />
                  <span>
                    <span className="font-medium">{placeLabel(r)}</span>
                    {r.country_code && (
                      <span className="mt-0.5 block text-xs text-subtle">{r.country_code}</span>
                    )}
                  </span>
                </button>
              ))}
            {q.trim().length < 2 && !searching && (
              <p className="px-3 py-4 text-sm text-muted">Type at least 2 characters to search.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
