import { V1RuleError } from "./errors.ts";
import { parseAsOf, parseTimeZone, readBestWindow, readOutlook } from "./phase2.ts";
import type { PushSender } from "./push.ts";
import { parseDeviceToken, requireId } from "./rules.ts";
import { samplePushPayloads } from "./samples.ts";
import {
  addSavedPlace,
  deliverForecastPush,
  issueForecast,
  listBeside,
  listSavedPlaces,
  recordOfficial,
  registerTestDevice,
  removeSavedPlace,
} from "./store.ts";
import type { Queryable } from "./types.ts";

export interface V1Deps {
  sql: Queryable;
  userId: string;
  sender: PushSender;
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
 * Paths: places, places/:id/best-window, places/:id/outlook, forecasts,
 * observations, push/devices, push/deliver, push/samples.
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
    if (err instanceof V1RuleError) {
      return json({ error: err.code, message: err.message }, err.status);
    }
    throw err;
  }
}

async function route(request: Request, url: URL, rest: string[], deps: V1Deps): Promise<Response> {
  const method = request.method.toUpperCase();

  if (rest[0] === "places" && rest.length === 1) {
    if (method === "GET") {
      return json({ places: await listSavedPlaces(deps.sql, deps.userId) });
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
    if (rest[2] !== "best-window" && rest[2] !== "outlook") {
      return json({ error: "not_found", message: "Unknown route" }, 404);
    }
    if (method !== "GET") {
      return json({ error: "method_not_allowed", message: "Method not allowed" }, 405);
    }
    const asOf = parseAsOf(url.searchParams.get("asOf"));
    if (rest[2] === "best-window") {
      return json(await readBestWindow(deps.sql, deps.userId, placeId, asOf));
    }
    return json(
      await readOutlook(
        deps.sql,
        deps.userId,
        placeId,
        asOf,
        parseTimeZone(url.searchParams.get("timeZone")),
      ),
    );
  }

  if (rest[0] === "forecasts" && rest.length === 1) {
    if (method === "GET") {
      const placeId = url.searchParams.get("placeId");
      const forecasts = await listBeside(
        deps.sql,
        deps.userId,
        placeId ? requireId(placeId, "placeId") : undefined,
      );
      return json({ forecasts });
    }
    if (method === "POST") {
      const forecast = await issueForecast(deps.sql, deps.userId, await readJson(request));
      return json({ forecast }, 201);
    }
    return json({ error: "method_not_allowed", message: "Method not allowed" }, 405);
  }

  if (rest[0] === "observations" && rest.length === 1) {
    if (method === "POST") {
      const official = await recordOfficial(deps.sql, deps.userId, await readJson(request));
      return json({ official }, 201);
    }
    return json({ error: "method_not_allowed", message: "Method not allowed" }, 405);
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
      const deliveries = await deliverForecastPush(deps.sql, deps.userId, forecastId, deps.sender);
      return json({ deliveries });
    }
    return json({ error: "method_not_allowed", message: "Method not allowed" }, 405);
  }

  return json({ error: "not_found", message: "Unknown route" }, 404);
}
