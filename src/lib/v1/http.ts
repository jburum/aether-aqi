import { readAlerts } from "./alerts.ts";
import {
  assertPlaceOpen,
  loadPlaceAccess,
  readCurrentAir,
  readEntitlement,
  readTimeline,
  requireOpenPlace,
  requireProAlerts,
} from "./entitlements.ts";
import { NotEntitledError, V1RuleError } from "./errors.ts";
import { readMonitoringStatus } from "./monitoring.ts";
import { parseAsOf, parseTimeZone, readBestWindow, readOutlook } from "./phase2.ts";
import { ingestSavedPlaces, readIngestCycle } from "./place-ingest.ts";
import type { PushSender } from "./push.ts";
import { parseDeviceToken, requireId } from "./rules.ts";
import { samplePushPayloads } from "./samples.ts";
import {
  addSavedPlace,
  deliverForecastPush,
  issueForecast,
  listBeside,
  listSavedPlaces,
  readForecastPlaceId,
  recordOfficial,
  registerTestDevice,
  removeSavedPlace,
} from "./store.ts";
import type { Queryable } from "./types.ts";

export interface V1Deps {
  sql: Queryable;
  userId: string;
  sender: PushSender;
  /** Tests pass a fake. The route omits this and the ingest handler uses global fetch. */
  fetchImpl?: typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) throw new V1RuleError("invalid_json", "JSON body is required.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new V1RuleError("invalid_json", "JSON body is invalid.");
  }
}

/**
 * v1 HTTP surface. The route resolves the user, then calls this.
 * Paths: status, entitlement, places, places/:id/current, places/:id/timeline,
 * places/:id/best-window, places/:id/outlook, places/:id/alerts,
 * forecasts, observations, ingest/run, push/devices, push/deliver, push/samples.
 * Pro gates live here: alerts, any saved place after the first, and
 * push delivery of a forecast for a closed place.
 */
export async function handleV1(request: Request, deps: V1Deps): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "v1") {
    return json({ error: "not_found", message: "Unknown route" }, 404);
  }
  const rest = parts.slice(2).map((part) => decodeURIComponent(part));
  try {
    return await route(request, url, rest, deps);
  } catch (err) {
    if (err instanceof NotEntitledError) {
      return json(
        { error: err.code, message: err.message, feature: err.feature, tier: err.tier },
        err.status,
      );
    }
    if (err instanceof V1RuleError) {
      return json({ error: err.code, message: err.message }, err.status);
    }
    throw err;
  }
}

const PLACE_READS = new Set(["current", "timeline", "best-window", "outlook", "alerts"]);

function peekPlaceId(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const placeId = (body as { placeId?: unknown }).placeId;
  return typeof placeId === "string" ? placeId : null;
}

function requiredZone(timeZone: string | null): string {
  if (timeZone == null) {
    throw new V1RuleError("invalid_time_zone", "timeZone is required and must be an IANA zone.");
  }
  return timeZone;
}

async function route(request: Request, url: URL, rest: string[], deps: V1Deps): Promise<Response> {
  const method = request.method.toUpperCase();
  const now = new Date();

  if (rest[0] === "status" && rest.length === 1) {
    if (method !== "GET") {
      return json({ error: "method_not_allowed", message: "Method not allowed" }, 405);
    }
    return json(await readMonitoringStatus(deps.sql, parseAsOf(url.searchParams.get("asOf"))));
  }

  if (rest[0] === "entitlement" && rest.length === 1) {
    if (method !== "GET") {
      return json({ error: "method_not_allowed", message: "Method not allowed" }, 405);
    }
    return json(await readEntitlement(deps.sql, deps.userId, now));
  }

  if (rest[0] === "places" && rest.length === 1) {
    if (method === "GET") {
      const access = await loadPlaceAccess(deps.sql, deps.userId, now);
      const places = await listSavedPlaces(deps.sql, deps.userId);
      return json({ places, pro: access.pro, openPlaceIds: access.openPlaceIds });
    }
    if (method === "POST") {
      const place = await addSavedPlace(deps.sql, deps.userId, await readJson(request));
      return json({ place }, 201);
    }
    return json({ error: "method_not_allowed", message: "Method not allowed" }, 405);
  }

  if (rest[0] === "places" && rest.length === 2) {
    if (method === "DELETE") {
      await removeSavedPlace(deps.sql, deps.userId, requireId(rest[1], "placeId"));
      return new Response(null, { status: 204 });
    }
    return json({ error: "method_not_allowed", message: "Method not allowed" }, 405);
  }

  if (rest[0] === "places" && rest.length === 3) {
    const placeId = requireId(rest[1], "placeId");
    const kind = rest[2];
    if (!PLACE_READS.has(kind ?? "")) {
      return json({ error: "not_found", message: "Unknown route" }, 404);
    }
    if (method !== "GET") {
      return json({ error: "method_not_allowed", message: "Method not allowed" }, 405);
    }
    const asOf = parseAsOf(url.searchParams.get("asOf"));
    const timeZone =
      kind === "outlook" || kind === "alerts"
        ? parseTimeZone(url.searchParams.get("timeZone"))
        : null;
    await requireOpenPlace(deps.sql, deps.userId, placeId, now);
    if (kind === "current") {
      return json(await readCurrentAir(deps.sql, deps.userId, placeId, asOf));
    }
    if (kind === "timeline") {
      return json(await readTimeline(deps.sql, deps.userId, placeId, asOf));
    }
    if (kind === "best-window") {
      return json(await readBestWindow(deps.sql, deps.userId, placeId, asOf));
    }
    if (kind === "outlook") {
      return json(await readOutlook(deps.sql, deps.userId, placeId, asOf, requiredZone(timeZone)));
    }
    await requireProAlerts(deps.sql, deps.userId, now);
    return json(await readAlerts(deps.sql, deps.userId, placeId, asOf, requiredZone(timeZone)));
  }

  if (rest[0] === "forecasts" && rest.length === 1) {
    if (method === "GET") {
      const access = await loadPlaceAccess(deps.sql, deps.userId, now);
      const requested = url.searchParams.get("placeId");
      if (requested) {
        const placeId = requireId(requested, "placeId");
        assertPlaceOpen(access, placeId);
        return json({ forecasts: await listBeside(deps.sql, deps.userId, placeId) });
      }
      const open = new Set(access.openPlaceIds);
      const forecasts = await listBeside(deps.sql, deps.userId);
      return json({ forecasts: forecasts.filter((row) => open.has(row.place.id)) });
    }
    if (method === "POST") {
      const body = await readJson(request);
      const placeId = peekPlaceId(body);
      if (placeId) await requireOpenPlace(deps.sql, deps.userId, placeId, now);
      const forecast = await issueForecast(deps.sql, deps.userId, body);
      return json({ forecast }, 201);
    }
    return json({ error: "method_not_allowed", message: "Method not allowed" }, 405);
  }

  if (rest[0] === "observations" && rest.length === 1) {
    if (method === "POST") {
      const body = await readJson(request);
      const placeId = peekPlaceId(body);
      if (placeId) await requireOpenPlace(deps.sql, deps.userId, placeId, now);
      const official = await recordOfficial(deps.sql, deps.userId, body);
      return json({ official }, 201);
    }
    return json({ error: "method_not_allowed", message: "Method not allowed" }, 405);
  }

  if (rest[0] === "ingest" && rest[1] === "run" && rest.length === 2) {
    if (method !== "POST") {
      return json({ error: "method_not_allowed", message: "Method not allowed" }, 405);
    }
    const cycleUtc = await readIngestCycle(request, now);
    const places = await ingestSavedPlaces(deps.sql, deps.userId, {
      cycleUtc,
      fetchImpl: deps.fetchImpl ?? fetch,
    });
    return json({
      cycleUtc,
      places: places.map((place) => ({
        placeId: place.placeId,
        hrrr: place.hrrr,
        aqm: place.aqm,
        forecastsStored: place.forecastsStored,
        forecastsUnchanged: place.forecastsUnchanged,
        officialAqi: place.officialAqi,
        officialStatus: place.officialStatus,
        airnowError: place.airnowError,
      })),
    });
  }

  if (rest[0] === "push" && rest[1] === "samples" && rest.length === 2) {
    if (method === "GET") {
      return json({ sender: "test", payloads: samplePushPayloads() });
    }
    return json({ error: "method_not_allowed", message: "Method not allowed" }, 405);
  }

  if (rest[0] === "push" && rest[1] === "devices" && rest.length === 2) {
    if (method === "POST") {
      const token = parseDeviceToken(await readJson(request));
      const device = await registerTestDevice(deps.sql, deps.userId, token);
      return json({ device }, 201);
    }
    return json({ error: "method_not_allowed", message: "Method not allowed" }, 405);
  }

  if (rest[0] === "push" && rest[1] === "deliver" && rest.length === 2) {
    if (method === "POST") {
      const body = await readJson(request);
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new V1RuleError("invalid_body", "Delivery body must be an object.");
      }
      const forecastId = requireId((body as { forecastId?: unknown }).forecastId, "forecastId");
      const placeId = await readForecastPlaceId(deps.sql, deps.userId, forecastId);
      await requireOpenPlace(deps.sql, deps.userId, placeId, now);
      const deliveries = await deliverForecastPush(
        deps.sql,
        deps.userId,
        forecastId,
        deps.sender,
        now,
      );
      return json({ deliveries });
    }
    return json({ error: "method_not_allowed", message: "Method not allowed" }, 405);
  }

  return json({ error: "not_found", message: "Unknown route" }, 404);
}
