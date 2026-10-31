import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import {
  applySignedTransaction,
  effectiveEntitlement,
  readEntitlement,
  type EntitlementResponse,
} from "./entitlements.ts";
import { NotEntitledError, V1RuleError } from "./errors.ts";
import { handleV1 } from "./http.ts";
import { TestPushSender } from "./push.ts";
import {
  SAMPLE_FORECAST_DAY1,
  SAMPLE_FORECAST_DAY5,
  SAMPLE_ISSUED_AT,
  SAMPLE_OFFICIAL,
  SAMPLE_PLACE,
  SAMPLE_VALID_DAY1,
} from "./samples.ts";
import {
  FixtureStoreKitVerifier,
  fixtureSignedTransaction,
  unavailableStoreKitVerifier,
  type FixtureTransaction,
  type StoreKitVerifier,
} from "./storekit.ts";
import { addSavedPlace, issueForecast } from "./store.ts";
import type { Queryable } from "./types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const NOW = new Date("2026-10-31T15:00:00.000Z");
const ZONE = "America/Boise";
const ACTIVE_UNTIL = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";
const verifier = new FixtureStoreKitVerifier();

async function openDb(): Promise<Queryable> {
  const pg = new PGlite();
  await pg.waitReady;
  const dir = join(root, "migrations");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) {
    await pg.exec(readFileSync(join(dir, name), "utf8"));
  }
  return {
    query: async <T>(text: string, params: unknown[] = []) => {
      const result = await pg.query<T>(text, params);
      return result.rows;
    },
  };
}

function signed(overrides: Partial<FixtureTransaction> = {}): string {
  return fixtureSignedTransaction({
    productId: "yearly",
    expiresAt: ACTIVE_UNTIL,
    originalTransactionId: "fixture-txn-1",
    ...overrides,
  });
}

function call(sql: Queryable, userId = "user-a") {
  const sender = new TestPushSender();
  return (method: string, path: string, body?: unknown, asUser = userId) =>
    handleV1(
      new Request(`http://localhost${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }),
      { sql, userId: asUser, sender },
    );
}

async function placeBody(response: Response): Promise<{ id: string }> {
  const body = (await response.json()) as { place: { id: string } };
  return body.place;
}

async function errorBody(response: Response): Promise<{
  error: string;
  message: string;
  feature?: string;
  tier?: string;
}> {
  return (await response.json()) as {
    error: string;
    message: string;
    feature?: string;
    tier?: string;
  };
}

async function countFor(sql: Queryable, table: string, userId: string): Promise<number> {
  const rows = await sql.query<{ n: number }>(
    `select count(*)::int as n from ${table} where user_id = $1`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

describe("v1 phase 3 entitlements", { concurrency: 1 }, () => {
  it("verifies a fixture transaction locally and refuses anything else", async () => {
    const yearly = verifier.verify(signed(), NOW);
    assert.deepEqual(yearly, {
      product: "yearly",
      expiresAt: ACTIVE_UNTIL,
      state: "active",
      source: "storekit",
    });
    const monthly = verifier.verify(
      signed({ productId: "monthly", originalTransactionId: "fixture-txn-2" }),
      NOW,
    );
    assert.equal(monthly.product, "monthly");
    assert.equal(monthly.state, "active");

    const grace = verifier.verify(
      signed({ expiresAt: PAST, inGracePeriod: true, originalTransactionId: "fixture-grace" }),
      NOW,
    );
    assert.equal(grace.state, "grace");
    const expired = verifier.verify(
      signed({ expiresAt: PAST, originalTransactionId: "fixture-expired" }),
      NOW,
    );
    assert.equal(expired.state, "expired");
    const revoked = verifier.verify(
      signed({
        expiresAt: ACTIVE_UNTIL,
        revokedAt: "2026-10-01T00:00:00.000Z",
        inGracePeriod: true,
        originalTransactionId: "fixture-revoked",
      }),
      NOW,
    );
    assert.equal(revoked.state, "revoked");
    const atExpiry = verifier.verify(signed({ expiresAt: NOW.toISOString() }), NOW);
    assert.equal(atExpiry.state, "expired");

    const tampered = signed().replace(/[^.]+$/, Buffer.from('"nope"', "utf8").toString("base64url"));
    assert.throws(
      () => verifier.verify(tampered, NOW),
      (err: unknown) => err instanceof V1RuleError && err.code === "storekit_invalid",
    );
    assert.throws(
      () => verifier.verify("not-a-transaction", NOW),
      (err: unknown) => err instanceof V1RuleError && err.code === "storekit_invalid" && err.status === 400,
    );
    assert.throws(
      () =>
        verifier.verify(
          fixtureSignedTransaction({
            productId: "weekly" as "monthly",
            expiresAt: ACTIVE_UNTIL,
            originalTransactionId: "fixture-weekly",
          }),
          NOW,
        ),
      (err: unknown) => err instanceof V1RuleError && err.code === "storekit_invalid",
    );

    assert.throws(
      () => unavailableStoreKitVerifier.verify(signed(), NOW),
      (err: unknown) =>
        err instanceof V1RuleError && err.code === "storekit_unavailable" && err.status === 403,
    );

    for (const name of ["storekit.ts", "entitlements.ts"]) {
      const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), name), "utf8");
      assert.equal(source.includes("process.env"), false);
      assert.equal(source.includes("fetch("), false);
      assert.equal(/apple\.com/i.test(source), false);
    }
  });

  it("keeps one row per user and prices monthly at $1.99 and yearly at $12.99", async () => {
    const sql = await openDb();
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = () => {
      called = true;
      return Promise.reject(new Error("no network"));
    };
    try {
      const monthly = await applySignedTransaction(
        sql,
        "user-a",
        signed({ productId: "monthly" }),
        verifier,
        NOW,
      );
      assert.equal(monthly.pro, true);
      assert.equal(monthly.product, "monthly");
      assert.equal(monthly.priceUsd, "1.99");
      const yearly = await applySignedTransaction(sql, "user-a", signed(), verifier, NOW);
      assert.equal(yearly.product, "yearly");
      assert.equal(yearly.priceUsd, "12.99");
      assert.equal(yearly.source, "storekit");
      assert.equal(await countFor(sql, "entitlement", "user-a"), 1);

      const boom: StoreKitVerifier = {
        verify() {
          throw new Error("boom");
        },
      };
      await assert.rejects(
        () => applySignedTransaction(sql, "user-a", signed(), boom, NOW),
        (err: unknown) =>
          err instanceof V1RuleError && err.code === "storekit_invalid" && err.status === 400,
      );
      assert.equal(await countFor(sql, "entitlement", "user-a"), 1);
      assert.equal(called, false);
    } finally {
      globalThis.fetch = original;
    }

    assert.equal(effectiveEntitlement(null, NOW).state, "free");
    assert.equal(effectiveEntitlement(null, NOW).pro, false);
    const grace = effectiveEntitlement(
      { product: "monthly", source: "storekit", expiresAt: PAST, state: "grace" },
      NOW,
    );
    assert.equal(grace.pro, true);
    assert.equal(grace.tier, "pro");
    assert.equal(grace.state, "grace");
    assert.equal(grace.priceUsd, "1.99");
    const stale = effectiveEntitlement(
      { product: "yearly", source: "storekit", expiresAt: PAST, state: "active" },
      NOW,
    );
    assert.equal(stale.pro, false);
    assert.equal(stale.tier, "free");
    assert.equal(stale.state, "expired");
    assert.equal(stale.priceUsd, "12.99");
  });

  it("treats a user with no row as Free and keeps the open place's air", async () => {
    const sql = await openDb();
    const http = call(sql);
    const entitlement = await http("GET", "/api/v1/entitlement");
    assert.equal(entitlement.status, 200);
    assert.deepEqual((await entitlement.json()) as EntitlementResponse, {
      tier: "free",
      product: null,
      priceUsd: null,
      source: null,
      expiresAt: null,
      state: "free",
      pro: false,
    });
    const posted = await http("POST", "/api/v1/entitlement", { signedTransaction: signed() });
    assert.equal(posted.status, 405);

    const created = await http("POST", "/api/v1/places", SAMPLE_PLACE);
    assert.equal(created.status, 201);
    const place = await placeBody(created);

    const empty = await http("GET", `/api/v1/places/${place.id}/current?asOf=${SAMPLE_VALID_DAY1}`);
    assert.equal(empty.status, 200);
    const emptyBody = (await empty.json()) as { corrected: null; official: null };
    assert.equal(emptyBody.corrected, null);
    assert.equal(emptyBody.official, null);

    const second = await http("POST", "/api/v1/places", {
      ...SAMPLE_PLACE,
      name: "Second",
      latitude: 44,
    });
    assert.equal(second.status, 403);
    assert.notEqual(second.status, 500);
    assert.deepEqual(await errorBody(second), {
      error: "not_entitled",
      message: "Saved places beyond the first require Pro.",
      feature: "saved_places",
      tier: "free",
    });
    assert.equal(await countFor(sql, "saved_place", "user-a"), 1);

    await issueForecast(sql, "user-a", { ...SAMPLE_FORECAST_DAY1, placeId: place.id });
    await issueForecast(sql, "user-a", { ...SAMPLE_FORECAST_DAY5, placeId: place.id });
    const official = await http("POST", "/api/v1/observations", {
      ...SAMPLE_OFFICIAL,
      placeId: place.id,
    });
    assert.equal(official.status, 201);

    const current = await http(
      "GET",
      `/api/v1/places/${place.id}/current?asOf=${SAMPLE_VALID_DAY1}`,
    );
    assert.equal(current.status, 200);
    const currentBody = (await current.json()) as {
      corrected: { correctedAqi: number };
      official: { officialAqi: number; preliminary: boolean };
    };
    assert.equal(currentBody.corrected.correctedAqi, 155);
    assert.equal(currentBody.official.officialAqi, 48);
    assert.equal(currentBody.official.preliminary, true);

    const timeline = await http(
      "GET",
      `/api/v1/places/${place.id}/timeline?asOf=${SAMPLE_ISSUED_AT}`,
    );
    assert.equal(timeline.status, 200);
    const timelineBody = (await timeline.json()) as {
      through: string;
      hours: { correctedAqi: number }[];
    };
    assert.equal(timelineBody.through, "2026-11-01T15:00:00.000Z");
    assert.deepEqual(
      timelineBody.hours.map((hour) => hour.correctedAqi),
      [155],
    );

    const window = await http(
      "GET",
      `/api/v1/places/${place.id}/best-window?asOf=${SAMPLE_ISSUED_AT}`,
    );
    assert.equal(window.status, 200);
    const windowBody = (await window.json()) as { bestWindow: { peakCorrectedAqi: number } };
    assert.equal(windowBody.bestWindow.peakCorrectedAqi, 155);

    const outlook = await http(
      "GET",
      `/api/v1/places/${place.id}/outlook?asOf=${SAMPLE_ISSUED_AT}&timeZone=${encodeURIComponent(ZONE)}`,
    );
    assert.equal(outlook.status, 200);
    const outlookBody = (await outlook.json()) as { tomorrow: { summary: unknown } };
    assert.notEqual(outlookBody.tomorrow.summary, "no data");

    const alerts = await http(
      "GET",
      `/api/v1/places/${place.id}/alerts?asOf=${SAMPLE_ISSUED_AT}&timeZone=${encodeURIComponent(ZONE)}`,
    );
    assert.equal(alerts.status, 403);
    assert.notEqual(alerts.status, 500);
    assert.equal((await errorBody(alerts)).feature, "alerts");

    const noZone = await http("GET", `/api/v1/places/${place.id}/alerts?asOf=${SAMPLE_ISSUED_AT}`);
    assert.equal(noZone.status, 400);
    assert.equal((await errorBody(noZone)).error, "invalid_time_zone");

    const other = await http(
      "GET",
      `/api/v1/places/${place.id}/current?asOf=${SAMPLE_VALID_DAY1}`,
      undefined,
      "user-b",
    );
    assert.equal(other.status, 404);
    assert.equal((await errorBody(other)).error, "place_not_found");
  });

  it("lets an active Pro account open alerts and five places, and still caps the sixth", async () => {
    const sql = await openDb();
    const http = call(sql);
    await applySignedTransaction(sql, "user-a", signed(), verifier, NOW);
    const seen = await http("GET", "/api/v1/entitlement");
    assert.equal(seen.status, 200);
    assert.deepEqual((await seen.json()) as EntitlementResponse, {
      tier: "pro",
      product: "yearly",
      priceUsd: "12.99",
      source: "storekit",
      expiresAt: ACTIVE_UNTIL,
      state: "active",
      pro: true,
    });

    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const created = await http("POST", "/api/v1/places", {
        ...SAMPLE_PLACE,
        name: `Place ${i + 1}`,
        latitude: 43 + i / 10,
      });
      assert.equal(created.status, 201);
      ids.push((await placeBody(created)).id);
    }
    const sixth = await http("POST", "/api/v1/places", {
      ...SAMPLE_PLACE,
      name: "Place 6",
      latitude: 44,
    });
    assert.equal(sixth.status, 409);
    assert.equal((await errorBody(sixth)).error, "place_cap");
    await assert.rejects(() =>
      sql.query(
        `insert into saved_place (id, user_id, name, latitude, longitude, position)
         values ('sixth', 'user-a', 'Place 6', 44.1, -116.2, 6)`,
      ),
    );
    assert.equal(await countFor(sql, "saved_place", "user-a"), 5);

    const alerts = await http(
      "GET",
      `/api/v1/places/${ids[0]}/alerts?asOf=${SAMPLE_ISSUED_AT}&timeZone=${encodeURIComponent(ZONE)}`,
    );
    assert.equal(alerts.status, 200);
    const alertsBody = (await alerts.json()) as { alerts: unknown[] };
    assert.ok(Array.isArray(alertsBody.alerts));

    const second = await http(
      "GET",
      `/api/v1/places/${ids[1]}/current?asOf=${SAMPLE_VALID_DAY1}`,
    );
    assert.equal(second.status, 200);

    await applySignedTransaction(
      sql,
      "user-a",
      signed({ expiresAt: PAST, inGracePeriod: true, originalTransactionId: "fixture-grace" }),
      verifier,
      NOW,
    );
    const duringGrace = await readEntitlement(sql, "user-a", NOW);
    assert.equal(duringGrace.state, "grace");
    assert.equal(duringGrace.pro, true);
    const graceAlerts = await http(
      "GET",
      `/api/v1/places/${ids[0]}/alerts?asOf=${SAMPLE_ISSUED_AT}&timeZone=${encodeURIComponent(ZONE)}`,
    );
    assert.equal(graceAlerts.status, 200);
    const proFlag = await sql.query<{ pro: boolean }>(
      "select saved_place_user_is_pro($1, $2) as pro",
      ["user-a", PAST],
    );
    assert.equal(proFlag[0]?.pro, true);
  });

  it("closes Pro when the subscription is expired or revoked", async () => {
    const sql = await openDb();
    const http = call(sql);
    const place = await addSavedPlace(sql, "user-a", SAMPLE_PLACE);
    await applySignedTransaction(
      sql,
      "user-a",
      signed({ expiresAt: PAST, originalTransactionId: "fixture-expired" }),
      verifier,
      NOW,
    );
    const expiredResponse = await http("GET", "/api/v1/entitlement");
    assert.equal(expiredResponse.status, 200);
    const expired = (await expiredResponse.json()) as EntitlementResponse;
    assert.deepEqual(expired, {
      tier: "free",
      product: "yearly",
      priceUsd: "12.99",
      source: "storekit",
      expiresAt: PAST,
      state: "expired",
      pro: false,
    });
    const alerts = await http(
      "GET",
      `/api/v1/places/${place.id}/alerts?asOf=${SAMPLE_ISSUED_AT}&timeZone=${encodeURIComponent(ZONE)}`,
    );
    assert.equal(alerts.status, 403);
    assert.equal((await errorBody(alerts)).feature, "alerts");
    const second = await http("POST", "/api/v1/places", {
      ...SAMPLE_PLACE,
      name: "Second",
      latitude: 44,
    });
    assert.equal(second.status, 403);
    assert.equal((await errorBody(second)).feature, "saved_places");

    await sql.query(
      `update entitlement
          set state = 'active', expires_at = $2
        where user_id = $1`,
      ["user-a", PAST],
    );
    const stale = await readEntitlement(sql, "user-a", NOW);
    assert.equal(stale.state, "expired");
    assert.equal(stale.pro, false);
    const staleFlag = await sql.query<{ pro: boolean }>(
      "select saved_place_user_is_pro($1, $2) as pro",
      ["user-a", NOW.toISOString()],
    );
    assert.equal(staleFlag[0]?.pro, false);

    await applySignedTransaction(
      sql,
      "user-a",
      signed({
        expiresAt: ACTIVE_UNTIL,
        revokedAt: "2026-10-01T00:00:00.000Z",
        originalTransactionId: "fixture-revoked",
      }),
      verifier,
      NOW,
    );
    const revoked = (await (await http("GET", "/api/v1/entitlement")).json()) as EntitlementResponse;
    assert.equal(revoked.pro, false);
    assert.equal(revoked.tier, "free");
    assert.equal(revoked.state, "revoked");
    assert.equal(revoked.expiresAt, ACTIVE_UNTIL);
    assert.equal(revoked.product, "yearly");
    const revokedAlerts = await http(
      "GET",
      `/api/v1/places/${place.id}/alerts?asOf=${SAMPLE_ISSUED_AT}&timeZone=${encodeURIComponent(ZONE)}`,
    );
    assert.equal(revokedAlerts.status, 403);
    assert.notEqual(revokedAlerts.status, 500);
    const revokedFlag = await sql.query<{ pro: boolean }>(
      "select saved_place_user_is_pro($1, $2) as pro",
      ["user-a", NOW.toISOString()],
    );
    assert.equal(revokedFlag[0]?.pro, false);
  });

  it("keeps five places after a downgrade and gates access past the first", async () => {
    const sql = await openDb();
    const http = call(sql);
    await applySignedTransaction(sql, "user-a", signed(), verifier, NOW);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const created = await http("POST", "/api/v1/places", {
        ...SAMPLE_PLACE,
        name: `Place ${i + 1}`,
        latitude: 43 + i / 10,
      });
      assert.equal(created.status, 201);
      ids.push((await placeBody(created)).id);
    }
    const first = ids[0] as string;
    const second = ids[1] as string;
    const third = ids[2] as string;

    const seeded = await http("POST", "/api/v1/forecasts", {
      ...SAMPLE_FORECAST_DAY1,
      placeId: first,
    });
    assert.equal(seeded.status, 201);
    const seededSecond = await http("POST", "/api/v1/forecasts", {
      ...SAMPLE_FORECAST_DAY1,
      placeId: second,
    });
    assert.equal(seededSecond.status, 201);
    const official = await http("POST", "/api/v1/observations", {
      ...SAMPLE_OFFICIAL,
      placeId: first,
    });
    assert.equal(official.status, 201);
    await issueForecast(sql, "user-a", { ...SAMPLE_FORECAST_DAY5, placeId: first });

    const openWhilePro = await http(
      "GET",
      `/api/v1/places/${second}/current?asOf=${SAMPLE_VALID_DAY1}`,
    );
    assert.equal(openWhilePro.status, 200);

    await applySignedTransaction(
      sql,
      "user-a",
      signed({ expiresAt: PAST, originalTransactionId: "fixture-downgrade" }),
      verifier,
      NOW,
    );
    assert.equal(await countFor(sql, "saved_place", "user-a"), 5);
    assert.equal(await countFor(sql, "entitlement", "user-a"), 1);

    const listed = await http("GET", "/api/v1/places");
    assert.equal(listed.status, 200);
    const listedBody = (await listed.json()) as {
      places: { id: string }[];
      pro: boolean;
      openPlaceIds: string[];
    };
    assert.equal(listedBody.places.length, 5);
    assert.equal(listedBody.pro, false);
    assert.deepEqual(listedBody.openPlaceIds, [first]);

    const current = await http("GET", `/api/v1/places/${first}/current?asOf=${SAMPLE_VALID_DAY1}`);
    assert.equal(current.status, 200);
    const currentBody = (await current.json()) as {
      corrected: { correctedAqi: number };
      official: { officialAqi: number };
    };
    assert.equal(currentBody.corrected.correctedAqi, 155);
    assert.equal(currentBody.official.officialAqi, 48);

    const timeline = await http(
      "GET",
      `/api/v1/places/${first}/timeline?asOf=${SAMPLE_ISSUED_AT}`,
    );
    const timelineBody = (await timeline.json()) as { hours: { correctedAqi: number }[] };
    assert.equal(timeline.status, 200);
    assert.deepEqual(
      timelineBody.hours.map((hour) => hour.correctedAqi),
      [155],
    );
    const window = await http(
      "GET",
      `/api/v1/places/${first}/best-window?asOf=${SAMPLE_ISSUED_AT}`,
    );
    assert.equal(window.status, 200);
    const outlook = await http(
      "GET",
      `/api/v1/places/${first}/outlook?asOf=${SAMPLE_ISSUED_AT}&timeZone=${encodeURIComponent(ZONE)}`,
    );
    assert.equal(outlook.status, 200);

    const alerts = await http(
      "GET",
      `/api/v1/places/${first}/alerts?asOf=${SAMPLE_ISSUED_AT}&timeZone=${encodeURIComponent(ZONE)}`,
    );
    assert.equal(alerts.status, 403);
    assert.equal((await errorBody(alerts)).feature, "alerts");

    for (const kind of ["current", "timeline", "best-window", "outlook", "alerts"]) {
      const path =
        kind === "outlook" || kind === "alerts"
          ? `/api/v1/places/${second}/${kind}?asOf=${SAMPLE_ISSUED_AT}&timeZone=${encodeURIComponent(ZONE)}`
          : `/api/v1/places/${second}/${kind}?asOf=${SAMPLE_ISSUED_AT}`;
      const gated = await http("GET", path);
      assert.equal(gated.status, 403, kind);
      assert.notEqual(gated.status, 500, kind);
      assert.equal((await errorBody(gated)).feature, "saved_places", kind);
    }

    const forecasts = await http("GET", "/api/v1/forecasts");
    const forecastBody = (await forecasts.json()) as { forecasts: { place: { id: string } }[] };
    const visible = forecastBody.forecasts.map((row) => row.place.id);
    assert.equal(visible.includes(first), true);
    assert.equal(visible.includes(second), false);
    const hidden = await http("GET", `/api/v1/forecasts?placeId=${second}`);
    assert.equal(hidden.status, 403);
    const storedSecond = await sql.query<{ n: number }>(
      "select count(*)::int as n from forecast_issued where place_id = $1",
      [second],
    );
    assert.equal(storedSecond[0]?.n, 1);

    const refused = await http("POST", "/api/v1/forecasts", {
      ...SAMPLE_FORECAST_DAY1,
      placeId: second,
      issuedAt: "2026-10-30T16:00:00.000Z",
      validFor: "2026-10-31T16:00:00.000Z",
    });
    assert.equal(refused.status, 403);
    const stillStored = await sql.query<{ n: number }>(
      "select count(*)::int as n from forecast_issued where place_id = $1",
      [second],
    );
    assert.equal(stillStored[0]?.n, 1);

    const sixth = await http("POST", "/api/v1/places", {
      ...SAMPLE_PLACE,
      name: "Place 6",
      latitude: 44,
    });
    assert.equal(sixth.status, 409);
    assert.equal((await errorBody(sixth)).error, "place_cap");
    assert.equal(await countFor(sql, "saved_place", "user-a"), 5);

    const removed = await http("DELETE", `/api/v1/places/${first}`);
    assert.equal(removed.status, 204);
    const promoted = await http(
      "GET",
      `/api/v1/places/${second}/current?asOf=${SAMPLE_VALID_DAY1}`,
    );
    assert.equal(promoted.status, 200);
    const stillGated = await http(
      "GET",
      `/api/v1/places/${third}/current?asOf=${SAMPLE_VALID_DAY1}`,
    );
    assert.equal(stillGated.status, 403);
    assert.equal((await errorBody(stillGated)).feature, "saved_places");
    assert.equal(await countFor(sql, "saved_place", "user-a"), 4);
  });

  it("delivers the first place after a downgrade and refuses places 2 through 5", async () => {
    const sql = await openDb();
    const sender = new TestPushSender();
    const http = (method: string, path: string, body?: unknown) =>
      handleV1(
        new Request(`http://localhost${path}`, {
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        }),
        { sql, userId: "user-a", sender },
      );

    await applySignedTransaction(sql, "user-a", signed(), verifier, NOW);
    const placeIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const created = await http("POST", "/api/v1/places", {
        ...SAMPLE_PLACE,
        name: `Deliver place ${i + 1}`,
        latitude: 43 + i / 10,
      });
      assert.equal(created.status, 201);
      placeIds.push((await placeBody(created)).id);
    }

    const forecastIds: string[] = [];
    for (const [index, placeId] of placeIds.entries()) {
      const issued = await http("POST", "/api/v1/forecasts", {
        ...SAMPLE_FORECAST_DAY1,
        placeId,
        correctedAqi: 150 + index,
      });
      assert.equal(issued.status, 201);
      const issuedBody = (await issued.json()) as { forecast: { id: string } };
      forecastIds.push(issuedBody.forecast.id);
      const officialAqi = 40 + index;
      const official = await http("POST", "/api/v1/observations", {
        ...SAMPLE_OFFICIAL,
        placeId,
        officialAqi,
        officialRaw: String(officialAqi),
      });
      assert.equal(official.status, 201);
    }

    await applySignedTransaction(
      sql,
      "user-a",
      signed({ expiresAt: PAST, originalTransactionId: "fixture-downgrade-push" }),
      verifier,
      NOW,
    );

    const device = await http("POST", "/api/v1/push/devices", {
      token: "test-device-boise",
      platform: "test",
    });
    assert.equal(device.status, 201);

    const open = await http("POST", "/api/v1/push/deliver", { forecastId: forecastIds[0] });
    assert.equal(open.status, 200);
    const openBody = (await open.json()) as {
      deliveries: {
        payload: { placeId: string; forecast: { correctedAqi: number }; official: { aqi: number } };
      }[];
    };
    assert.equal(openBody.deliveries.length, 1);
    assert.equal(openBody.deliveries[0]?.payload.placeId, placeIds[0]);
    assert.equal(openBody.deliveries[0]?.payload.forecast.correctedAqi, 150);
    assert.equal(openBody.deliveries[0]?.payload.official.aqi, 40);

    for (const [index, forecastId] of forecastIds.entries()) {
      if (index === 0) continue;
      const denied = await http("POST", "/api/v1/push/deliver", { forecastId });
      assert.equal(denied.status, 403, `place ${index + 1}`);
      assert.notEqual(denied.status, 500, `place ${index + 1}`);
      const body = await errorBody(denied);
      assert.equal(body.error, "not_entitled", `place ${index + 1}`);
      assert.equal(body.feature, "saved_places", `place ${index + 1}`);
      assert.equal(body.tier, "free", `place ${index + 1}`);
      assert.equal("deliveries" in body, false, `place ${index + 1}`);
      const written = await sql.query<{ n: number }>(
        "select count(*)::int as n from push_delivery where forecast_id = $1",
        [forecastId],
      );
      assert.equal(written[0]?.n, 0, `place ${index + 1}`);
    }

    const deliveries = await sql.query<{ n: number }>(
      "select count(*)::int as n from push_delivery where user_id = $1",
      ["user-a"],
    );
    assert.equal(deliveries[0]?.n, 1);
    assert.deepEqual(
      sender.sent.map((payload) => payload.placeId),
      [placeIds[0]],
    );
  });

  it("rejects a second place from the library with not_entitled, not a 500", async () => {
    const sql = await openDb();
    await addSavedPlace(sql, "user-a", SAMPLE_PLACE);
    await assert.rejects(
      () => addSavedPlace(sql, "user-a", { ...SAMPLE_PLACE, name: "Second", latitude: 44 }),
      (err: unknown) =>
        err instanceof NotEntitledError &&
        err.code === "not_entitled" &&
        err.status === 403 &&
        err.feature === "saved_places",
    );
  });
});
