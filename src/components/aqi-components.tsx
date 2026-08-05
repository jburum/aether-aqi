import { useMemo, useState, useEffect, useCallback, useId, useRef } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  MapPin,
  Navigation,
  Plus,
  RefreshCw,
  Trash2,
  Wind,
  X,
  Search,
  Loader2,
  ChevronDown,
  ChevronLeft,
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

type AqiData = AirQualityPayload & { mainPollutant: string };
type ForecastMode = "hour" | "day";

const SWIPE_ACTION_W = 88;
const SWIPE_OPEN_THRESHOLD = 48;

const AQI_CSS: Record<string, string> = {
  good: "var(--color-aqi-good)",
  moderate: "var(--color-aqi-moderate)",
  usg: "var(--color-aqi-usg)",
  unhealthy: "var(--color-aqi-unhealthy)",
  very: "var(--color-aqi-very)",
  hazardous: "var(--color-aqi-hazardous)",
  unknown: "var(--color-aqi-unknown)",
};

function aqiColorClass(token: string) {
  return `aqi-${token}`;
}
function aqiBgClass(token: string) {
  return `bg-aqi-${token}`;
}
function aqiRingClass(token: string) {
  return `ring-aqi-${token}`;
}
function aqiCss(token: string) {
  return AQI_CSS[token] ?? AQI_CSS.unknown;
}

type HourlyPoint = {
  time: string;
  label: string;
  short: string;
  aqi: number;
  day: string;
};

type DailyPoint = {
  day: string;
  label: string;
  shortLabel: string;
  avg: number;
  max: number;
  min: number;
  token: string;
  levelLabel: string;
};

export function AirQualityApp() {
  const locations = useLocationsStore((s) => s.locations);
  const selectedId = useLocationsStore((s) => s.selectedId);
  const selectLocation = useLocationsStore((s) => s.selectLocation);
  const removeLocation = useLocationsStore((s) => s.removeLocation);
  const canAdd = useLocationsStore((s) => s.canAdd);
  const [addOpen, setAddOpen] = useState(false);
  const qc = useQueryClient();

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

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    for (let i = 0; i < locations.length; i++) {
      const loc = locations[i];
      const data = queries[i]?.data;
      if (!loc || !data || loc.alertAt == null) continue;
      const aqi = data.current.us_aqi;
      if (aqi == null || aqi < loc.alertAt) continue;
      const key = `aqi-alerted-${loc.id}-${data.current.time}`;
      if (sessionStorage.getItem(key)) continue;
      sessionStorage.setItem(key, "1");
      const meta = getAqiMeta(aqi);
      try {
        new Notification(`${loc.name}: AQI ${Math.round(aqi)}`, {
          body: `${meta.label}. ${meta.advice}`,
          icon: "/icon-192.png",
          tag: `aqi-${loc.id}`,
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
            <span className="text-xs font-medium uppercase tracking-[0.14em]">
              Air quality
            </span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Watchlist
          </h1>
          <p className="max-w-xl text-sm text-muted">
            Live US AQI and forecasts for up to {MAX_LOCATIONS} places. Data from
            Open-Meteo (CAMS). Saved on this device.
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
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {locations.map((loc, i) => (
            <LocationCard
              key={loc.id}
              location={loc}
              data={queries[i]?.data}
              isLoading={queries[i]?.isLoading}
              isError={queries[i]?.isError}
              isFetching={queries[i]?.isFetching}
              expanded={selectedId === loc.id}
              onToggle={() =>
                selectLocation(selectedId === loc.id ? null : loc.id)
              }
              onDelete={() => removeLocation(loc.id)}
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
      )}

      {addOpen && <AddLocationModal onClose={() => setAddOpen(false)} />}
    </div>
  );
}

/** @deprecated Prefer AirQualityApp */
export const AetherApp = AirQualityApp;

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-[var(--radius-xl)] border border-border bg-surface p-10 text-center">
      <MapPin className="mx-auto mb-3 size-8 text-subtle" />
      <h2 className="text-lg font-medium">No locations yet</h2>
      <p className="mt-1 text-sm text-muted">
        Add up to {MAX_LOCATIONS} places to track air quality.
      </p>
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
  isFetching,
  expanded,
  onToggle,
  onDelete,
}: {
  location: TrackedLocation;
  data?: AqiData;
  isLoading?: boolean;
  isError?: boolean;
  isFetching?: boolean;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const aqi = data?.current.us_aqi ?? null;
  const meta = getAqiMeta(aqi);
  const [offset, setOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [forecastMode, setForecastMode] = useState<ForecastMode>("hour");
  const surfaceRef = useRef<HTMLDivElement>(null);

  const draggingRef = useRef(false);
  const startX = useRef(0);
  const startY = useRef(0);
  const startOffset = useRef(0);
  const offsetRef = useRef(0);
  const axisLock = useRef<"h" | "v" | null>(null);
  const movedRef = useRef(false);
  const suppressClickRef = useRef(false);

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

  const setOffsetBoth = useCallback((v: number) => {
    offsetRef.current = v;
    setOffset(v);
  }, []);

  const closeSwipe = useCallback(() => setOffsetBoth(0), [setOffsetBoth]);

  const beginDrag = useCallback(
    (clientX: number, clientY: number, target: EventTarget | null) => {
      if ((target as HTMLElement | null)?.closest?.("[data-no-swipe]")) return false;
      draggingRef.current = true;
      movedRef.current = false;
      suppressClickRef.current = false;
      startX.current = clientX;
      startY.current = clientY;
      startOffset.current = offsetRef.current;
      axisLock.current = null;
      setIsDragging(true);
      return true;
    },
    [],
  );

  const moveDrag = useCallback(
    (clientX: number, clientY: number) => {
      if (!draggingRef.current) return false;
      const dx = clientX - startX.current;
      const dy = clientY - startY.current;
      if (!axisLock.current) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return false;
        axisLock.current = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
        if (axisLock.current === "v") {
          draggingRef.current = false;
          setIsDragging(false);
          return false;
        }
      }
      if (axisLock.current !== "h") return false;
      movedRef.current = true;
      suppressClickRef.current = true;
      const next = Math.min(0, Math.max(-SWIPE_ACTION_W, startOffset.current + dx));
      setOffsetBoth(next);
      return true;
    },
    [setOffsetBoth],
  );

  const endDrag = useCallback(() => {
    if (!draggingRef.current && !isDragging) return;
    draggingRef.current = false;
    setIsDragging(false);
    if (axisLock.current === "v") {
      axisLock.current = null;
      return;
    }
    const shouldOpen = offsetRef.current < -SWIPE_OPEN_THRESHOLD;
    setOffsetBoth(shouldOpen ? -SWIPE_ACTION_W : 0);
    axisLock.current = null;
  }, [isDragging, setOffsetBoth]);

  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (!beginDrag(e.clientX, e.clientY, e.target)) return;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (moveDrag(e.clientX, e.clientY)) e.preventDefault();
    };
    const onPointerUp = (e: PointerEvent) => {
      endDrag();
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      beginDrag(e.touches[0].clientX, e.touches[0].clientY, e.target);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      if (moveDrag(e.touches[0].clientX, e.touches[0].clientY)) e.preventDefault();
    };
    const onTouchEnd = () => endDrag();

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [beginDrag, moveDrag, endDrag]);

  function handleCardActivate() {
    if (suppressClickRef.current || movedRef.current) {
      if (offsetRef.current < 0) closeSwipe();
      suppressClickRef.current = false;
      movedRef.current = false;
      return;
    }
    if (offsetRef.current < 0) {
      closeSwipe();
      return;
    }
    onToggle();
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[var(--radius-xl)]",
        expanded && "sm:col-span-2 lg:col-span-3",
      )}
    >
      <div
        className="absolute inset-y-0 right-0 flex w-[88px] items-stretch"
        aria-hidden={offset === 0}
      >
        <button
          type="button"
          data-no-swipe
          onClick={(e) => {
            e.stopPropagation();
            closeSwipe();
            onDelete();
          }}
          className="flex w-full flex-col items-center justify-center gap-1 transition-opacity hover:opacity-90 active:scale-[0.98]"
          style={{ background: "var(--color-aqi-unhealthy)", color: "#fff" }}
          aria-label={`Delete ${location.name}`}
        >
          <Trash2 className="size-5" />
          <span className="text-xs font-medium">Delete</span>
        </button>
      </div>

      <div
        ref={surfaceRef}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleCardActivate();
          }
          if (e.key === "Escape" && offsetRef.current !== 0) {
            e.preventDefault();
            closeSwipe();
          }
        }}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("[data-no-swipe]")) return;
          handleCardActivate();
        }}
        className={cn(
          "relative z-[1] flex flex-col gap-3 border border-border bg-surface p-5 text-left",
          "rounded-[var(--radius-xl)] select-none hover:border-border-strong",
          expanded && "border-border-strong ring-1 ring-ring/30",
          aqiRingClass(meta.token),
          !isDragging && "transition-transform duration-200 ease-out",
        )}
        style={{ transform: `translate3d(${offset}px,0,0)`, touchAction: "pan-y" }}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium leading-snug">{location.name}</p>
            <p className="mt-0.5 text-xs text-subtle">
              {location.latitude.toFixed(2)}°, {location.longitude.toFixed(2)}°
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isLoading || isFetching ? (
              <Loader2 className="size-4 animate-spin text-subtle" />
            ) : isError ? (
              <span className="text-xs text-aqi-unhealthy">Error</span>
            ) : null}
            <ChevronDown
              className={cn(
                "size-4 text-subtle transition-transform duration-200",
                expanded && "rotate-180",
              )}
              aria-hidden
            />
          </div>
        </div>

        <div className="flex items-end justify-between gap-3">
          <div>
            <p
              className={cn(
                "text-4xl font-semibold tracking-tight tabular",
                aqiColorClass(meta.token),
              )}
            >
              {formatAqi(aqi)}
            </p>
            <p className={cn("mt-1 text-xs font-medium", aqiColorClass(meta.token))}>
              {meta.label}
            </p>
          </div>
          <div className="text-right text-xs text-muted">
            <p>US AQI</p>
            {data?.mainPollutant && data.mainPollutant !== "—" && (
              <p className="mt-1 text-subtle">Main: {data.mainPollutant}</p>
            )}
          </div>
        </div>

        {spark.length > 1 && !expanded && (
          <div className="h-8 w-full opacity-80">
            <Sparkline values={spark} token={meta.token} />
          </div>
        )}

        {expanded && (
          <div
            className="mt-1 space-y-4 border-t border-border pt-4"
            data-no-swipe
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <p className="text-sm text-muted">{meta.advice}</p>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <PollutantStat label="PM2.5" value={data?.current.pm2_5} unit="µg/m³" />
              <PollutantStat label="PM10" value={data?.current.pm10} unit="µg/m³" />
              <PollutantStat label="Ozone" value={data?.current.ozone} unit="µg/m³" />
              <PollutantStat label="NO₂" value={data?.current.nitrogen_dioxide} unit="µg/m³" />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Forecast</h3>
              <div
                className="inline-flex rounded-[var(--radius-md)] border border-border bg-surface-2 p-0.5"
                role="tablist"
                aria-label="Forecast granularity"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={forecastMode === "hour"}
                  data-no-swipe
                  onClick={() => setForecastMode("hour")}
                  className={cn(
                    "rounded-[var(--radius-sm)] px-3 py-1.5 text-xs font-medium transition-colors",
                    forecastMode === "hour"
                      ? "bg-accent text-accent-fg"
                      : "text-muted hover:text-fg",
                  )}
                >
                  By hour
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={forecastMode === "day"}
                  data-no-swipe
                  onClick={() => setForecastMode("day")}
                  className={cn(
                    "rounded-[var(--radius-sm)] px-3 py-1.5 text-xs font-medium transition-colors",
                    forecastMode === "day"
                      ? "bg-accent text-accent-fg"
                      : "text-muted hover:text-fg",
                  )}
                >
                  By day
                </button>
              </div>
            </div>

            <ExpandedForecast data={data} isLoading={isLoading} mode={forecastMode} />

            <p className="text-xs text-subtle">
              Modeled US AQI via Open-Meteo / CAMS. Not a substitute for local
              regulatory monitors (AirNow) during wildfire events.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function buildHourly(data?: AqiData): HourlyPoint[] {
  if (!data?.hourly) return [];
  return data.hourly.time
    .map((t, i) => {
      const aqi = data.hourly.us_aqi[i];
      if (aqi == null) return null;
      return {
        time: t,
        label: format(parseISO(t), "EEE Ha"),
        short: format(parseISO(t), "Ha"),
        aqi,
        day: format(parseISO(t), "yyyy-MM-dd"),
      };
    })
    .filter((d): d is HourlyPoint => d != null);
}

function buildDaily(hourly: HourlyPoint[]): DailyPoint[] {
  const map = new Map<string, number[]>();
  for (const row of hourly) {
    const arr = map.get(row.day) ?? [];
    arr.push(row.aqi);
    map.set(row.day, arr);
  }
  return [...map.entries()].map(([day, vals]) => {
    const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    const meta = getAqiMeta(avg);
    return {
      day,
      label: format(parseISO(day), "EEE M/d"),
      shortLabel: format(parseISO(day), "EEE"),
      avg,
      max,
      min,
      token: meta.token,
      levelLabel: meta.label,
    };
  });
}

function ExpandedForecast({
  data,
  isLoading,
  mode,
}: {
  data?: AqiData;
  isLoading?: boolean;
  mode: ForecastMode;
}) {
  const [drillDay, setDrillDay] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "day") setDrillDay(null);
  }, [mode]);

  const hourly = useMemo(() => buildHourly(data), [data]);
  const daily = useMemo(() => buildDaily(hourly), [hourly]);
  const drillMeta = useMemo(
    () => daily.find((d) => d.day === drillDay) ?? null,
    [daily, drillDay],
  );
  const dayHourly = useMemo(() => {
    if (!drillDay) return [];
    return hourly.filter((h) => h.day === drillDay);
  }, [hourly, drillDay]);

  if (isLoading) {
    return <div className="h-56 animate-pulse rounded-[var(--radius-lg)] bg-surface-2" />;
  }

  if (mode === "day") {
    if (daily.length === 0) {
      return <p className="text-sm text-muted">Daily forecast unavailable.</p>;
    }

    if (drillDay && drillMeta) {
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              data-no-swipe
              onClick={() => setDrillDay(null)}
              className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <ChevronLeft className="size-3.5" />
              All days
            </button>
            <div className="text-right">
              <p className="text-sm font-medium">{drillMeta.label}</p>
              <p className={cn("text-xs", aqiColorClass(drillMeta.token))}>
                avg {drillMeta.avg} · {drillMeta.levelLabel}
              </p>
            </div>
          </div>
          {dayHourly.length === 0 ? (
            <p className="text-sm text-muted">No hourly data for this day.</p>
          ) : (
            <HourlyAreaChart data={dayHourly} gradientId={`aqiFill-${drillDay}`} />
          )}
          <p className="text-xs text-subtle">Hourly US AQI for {drillMeta.label}</p>
        </div>
      );
    }

    return (
      <div className="space-y-2">
        <div className="h-60 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={daily}
              margin={{ top: 28, right: 8, left: -12, bottom: 4 }}
              barCategoryGap="28%"
            >
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="shortLabel"
                tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fill: "var(--color-subtle)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={36}
                domain={[0, (dataMax: number) => Math.max(50, Math.ceil(dataMax / 50) * 50)]}
              />
              <Tooltip
                cursor={{ fill: "color-mix(in oklab, var(--color-fg) 6%, transparent)" }}
                contentStyle={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 12,
                  color: "var(--color-fg)",
                  fontSize: 12,
                }}
                labelFormatter={(_label, payload) => {
                  const p = payload?.[0]?.payload as DailyPoint | undefined;
                  return p?.label ?? "";
                }}
                formatter={(value, _name, item) => {
                  const p = item?.payload as DailyPoint | undefined;
                  const n = typeof value === "number" ? Math.round(value) : value;
                  return [
                    `avg ${n}${p ? ` · low ${p.min} · peak ${p.max}` : ""}`,
                    "US AQI",
                  ];
                }}
              />
              <Bar
                dataKey="avg"
                radius={[8, 8, 4, 4]}
                maxBarSize={56}
                cursor="pointer"
                onClick={(entry) => {
                  const raw = entry as unknown as {
                    day?: string;
                    payload?: { day?: string };
                  };
                  const day = raw?.day ?? raw?.payload?.day;
                  if (typeof day === "string") setDrillDay(day);
                }}
              >
                {daily.map((d) => (
                  <Cell
                    key={d.day}
                    fill={aqiCss(d.token)}
                    fillOpacity={0.85}
                    stroke={aqiCss(d.token)}
                    strokeWidth={1}
                  />
                ))}
                <LabelList
                  dataKey="avg"
                  position="top"
                  offset={8}
                  style={{
                    fill: "var(--color-fg)",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                  formatter={(v: number | string) => String(Math.round(Number(v)))}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {daily.map((d) => (
            <button
              key={d.day}
              type="button"
              data-no-swipe
              onClick={() => setDrillDay(d.day)}
              className={cn(
                "rounded-full border border-border px-2.5 py-1 text-xs font-medium transition-colors",
                "hover:border-border-strong active:scale-[0.98]",
                aqiBgClass(d.token),
              )}
            >
              <span className="text-muted">{d.shortLabel}</span>{" "}
              <span className={cn("tabular", aqiColorClass(d.token))}>{d.avg}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-subtle">
          Bars show average US AQI. Tap a day for that day's hourly forecast.
        </p>
      </div>
    );
  }

  if (hourly.length === 0) {
    return <p className="text-sm text-muted">Hourly forecast unavailable.</p>;
  }

  return <HourlyAreaChart data={hourly} gradientId="aqiFill-all" />;
}

function HourlyAreaChart({
  data,
  gradientId,
}: {
  data: Array<{ short: string; label: string; aqi: number }>;
  gradientId: string;
}) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
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
            labelFormatter={(_label, payload) => {
              const p = payload?.[0]?.payload as { label?: string } | undefined;
              return p?.label ?? "";
            }}
            formatter={(value) => [
              `AQI ${typeof value === "number" ? Math.round(value) : value}`,
              "US AQI",
            ]}
          />
          <Area
            type="monotone"
            dataKey="aqi"
            stroke="var(--color-aqi-usg)"
            fill={`url(#${gradientId})`}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
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
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden>
      <polyline
        fill="none"
        stroke={aqiCss(token)}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={pts}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
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
