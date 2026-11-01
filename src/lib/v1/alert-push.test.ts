import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { pushAlertEpisodes, type AlertPushResult } from "./alert-push.ts";
import { readAlerts, recordStability } from "./alerts.ts";
import { NotEntitledError } from "./errors.ts";
import { assertPayloadSeparated, TestPushSender, type PushPayload, type PushSender } from "./push.ts";
import { AIRNOW_ATTRIBUTION } from "./rules.ts";
import { addSavedPlace, issueForecast, recordOfficial } from "./store.ts";
import type { Queryable } from "./types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const ZONE = "America/Boise";
const ISSUED_AT = "2026-01-15T12:00:00.000Z";
const FIRST = "2026-01-15T16:00:00.000Z";
const AS_OF = "2026-01-15T18:00:00.000Z";
const NOW = new Date(AS_OF);

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

function hoursAfter(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 3_600_000).toISOString();
}

async function grantPro(sql: Queryable, userId: string): Promise<void> {
  await sql.query(
    `insert into entitlement (user_id, tier, product, source, expires_at, state)
     values ($1, 'pro', 'yearly', 'storekit', '2099-01-01T00:00:00.000Z', 'active')`,
    [userId],
  );
}

async function expire(sql: Queryable, userId: string): Promise<void> {
  await sql.query(
    `update entitlement
        set state = 'expired', expires_at = '2020-01-01T00:00:00.000Z'
      where user_id = $1`,
    [userId],
  );
}

async function boise(sql: Queryable, userId: string, name = "Boise") {
  return addSavedPlace(sql, userId, {
    name,
    latitude: 43.615,
    longitude: -116.2023,
    valley: "Treasure Valley",
    alertAt: null,
  });
}

async function seedSmoke(
  sql: Queryable,
  userId: string,
  placeId: string,
  correctedAqi: number,
  options: { inversion?: boolean; hours?: number } = {},
): Promise<void> {
  const hours = options.hours ?? 6;
  for (let i = 0; i < hours; i += 1) {
    const validFor = hoursAfter(FIRST, i);
    await issueForecast(sql, userId, {
      placeId,
      source: "noaa_smoke",
      issuedAt: ISSUED_AT,
      validFor,
      horizon: "day_1_2_valley",
      spatialScale: "valley",
      confidence: "valley",
      correctedAqi,
      pollutant: "PM2.5",
    });
    if (options.inversion) {
      await recordStability(sql, userId, {
        placeId,
        issuedAt: ISSUED_AT,
        validFor,
        tmp2mK: 270,
        hpblM: 180,
        wind10mMs: 1.2,
      });
    }
  }
}

async function seedOfficial(
  sql: Queryable,
  userId: string,
  placeId: string,
  officialAqi: number,
): Promise<void> {
  await recordOfficial(sql, userId, {
    placeId,
    observedAt: FIRST,
    officialAqi,
    officialRaw: String(officialAqi),
    preliminary: true,
    attribution: AIRNOW_ATTRIBUTION,
    source: "airnow",
    parameter: "PM2.5",
  });
}

async function countOf(sql: Queryable, table: "alert_push" | "push_delivery"): Promise<number> {
  const rows = await sql.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return rows[0]?.n ?? 0;
}

function numbersStayApart(payload: PushPayload, corrected: number, official: number): void {
  assertPayloadSeparated(payload);
  assert.equal(payload.forecast.correctedAqi, corrected);
  assert.equal(payload.official?.aqi, official);
  assert.equal(payload.official?.raw, String(official));
  assert.notEqual(payload.forecast.correctedAqi, payload.official?.aqi);
  assert.equal("aqi" in payload.forecast, false);
  assert.equal("officialAqi" in payload.forecast, false);
  assert.equal(payload.official != null && "correctedAqi" in payload.official, false);
  for (const value of Object.values(payload.forecast)) {
    assert.notEqual(value, official);
  }
}

function holdSend(): {
  sender: PushSender;
  entered: Promise<void>;
  release: () => void;
  sends: () => number;
} {
  let sends = 0;
  let opened = false;
  let releaseHold!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    releaseHold = () => {
      if (opened) return;
      opened = true;
      resolve();
    };
  });
  const sender: PushSender = {
    name: "test",
    async send(payload: PushPayload) {
      sends += 1;
      assertPayloadSeparated(payload);
      markEntered();
      await hold;
      return { ok: true, providerId: `test-${sends}` };
    },
  };
  return {
    sender,
    entered,
    release: () => releaseHold(),
    sends: () => sends,
  };
}

async function waitForSend(entered: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("the push send did not start")), 10_000);
  });
  try {
    await Promise.race([entered, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function refused(
  feature: "alerts" | "saved_places",
): (err: unknown) => boolean {
  return (err: unknown) => {
    assert.ok(err instanceof NotEntitledError);
    assert.equal(err.code, "not_entitled");
    assert.equal(err.feature, feature);
    assert.equal(err.tier, "free");
    assert.equal(err.status, 403);
    assert.deepEqual(
      {
        error: err.code,
        message: err.message,
        feature: err.feature,
        tier: err.tier,
      },
      {
        error: "not_entitled",
        message: err.message,
        feature,
        tier: "free",
      },
    );
    return true;
  };
}

describe("v1 alert episode pushes", { concurrency: 1 }, () => {
  it("sends one Pro push per episode and a rerun sends nothing", async () => {
    const sql = await openDb();
    await grantPro(sql, "user-a");
    const place = await boise(sql, "user-a");
    await seedSmoke(sql, "user-a", place.id, 148, { inversion: true });
    await seedOfficial(sql, "user-a", place.id, 200);
    const alerts = await readAlerts(sql, "user-a", place.id, AS_OF, ZONE);
    assert.deepEqual(
      alerts.alerts.map((alert) => alert.kind),
      ["smoke", "inversion"],
    );
    assert.equal(alerts.alerts[0]?.peakAqi, 148);
    assert.equal(alerts.alerts[1]?.peakAqi, 148);

    const sender = new TestPushSender();
    const first = await pushAlertEpisodes(sql, place.id, AS_OF, ZONE, sender, NOW);
    assert.equal(first.sent.length, 2);
    assert.equal(first.failed.length, 0);
    assert.equal(first.skipped, 0);
    assert.deepEqual(
      first.sent.map((row) => row.kind),
      ["smoke", "inversion"],
    );
    assert.deepEqual(
      first.sent.map((row) => row.episodeStart),
      alerts.alerts.map((alert) => alert.start),
    );
    assert.equal(sender.sent.length, 2);
    for (const attempt of first.sent) {
      numbersStayApart(attempt.payload, 148, 200);
      assert.equal(attempt.payload.forecast.source, "noaa_smoke");
      assert.equal(attempt.status, "sent");
      assert.equal(attempt.payload.placeName, "Boise");
    }

    const stored = await sql.query<{
      kind: string;
      status: string;
      payload: PushPayload;
    }>("select kind, status, payload from alert_push order by kind");
    assert.equal(stored.length, 2);
    assert.deepEqual(
      stored.map((row) => row.status),
      ["sent", "sent"],
    );
    for (const row of stored) numbersStayApart(row.payload, 148, 200);
    assert.equal(await countOf(sql, "push_delivery"), 0);

    const again = await pushAlertEpisodes(sql, place.id, AS_OF, ZONE, sender, NOW);
    assert.equal(again.sent.length, 0);
    assert.equal(again.failed.length, 0);
    assert.equal(again.skipped, 2);
    assert.equal(sender.sent.length, 2);

    const later = hoursAfter(AS_OF, 1);
    const stepped = await pushAlertEpisodes(sql, place.id, later, ZONE, sender, new Date(later));
    assert.equal(stepped.sent.length, 0);
    assert.equal(stepped.skipped, 2);
    assert.equal(sender.sent.length, 2);
    assert.equal(await countOf(sql, "alert_push"), 2);
  });

  it("quotes the corrected hour when AirNow owns the episode", async () => {
    const sql = await openDb();
    await grantPro(sql, "user-a");
    const place = await boise(sql, "user-a");
    await seedSmoke(sql, "user-a", place.id, 60, { hours: 4 });
    await seedOfficial(sql, "user-a", place.id, 160);
    const alerts = await readAlerts(sql, "user-a", place.id, AS_OF, ZONE);
    const smoke = alerts.alerts.find((alert) => alert.kind === "smoke");
    assert.equal(smoke?.source, "airnow");
    assert.equal(smoke?.peakAqi, null);

    const sender = new TestPushSender();
    const first = await pushAlertEpisodes(sql, place.id, AS_OF, ZONE, sender, NOW);
    assert.equal(first.sent.length, 1);
    const payload = first.sent[0]?.payload;
    assert.ok(payload);
    numbersStayApart(payload, 60, 160);
    assert.equal(payload.forecast.source, "noaa_smoke");
    assert.equal(sender.sent.length, 1);

    const second = await pushAlertEpisodes(sql, place.id, AS_OF, ZONE, sender, NOW);
    assert.equal(second.sent.length, 0);
    assert.equal(second.skipped, 1);
    assert.equal(sender.sent.length, 1);
  });

  it("sends nothing and writes nothing for Free and for a locked place", async () => {
    const sql = await openDb();
    const freePlace = await boise(sql, "user-free");
    await seedSmoke(sql, "user-free", freePlace.id, 148, { hours: 4 });
    const sender = new TestPushSender();
    await assert.rejects(
      () => pushAlertEpisodes(sql, freePlace.id, AS_OF, ZONE, sender, NOW),
      refused("alerts"),
    );

    await grantPro(sql, "user-locked");
    const open = await boise(sql, "user-locked", "Boise");
    const locked = await boise(sql, "user-locked", "Nampa");
    await expire(sql, "user-locked");
    await seedSmoke(sql, "user-locked", open.id, 148, { hours: 4 });
    await seedSmoke(sql, "user-locked", locked.id, 148, { hours: 4 });
    await assert.rejects(
      () => pushAlertEpisodes(sql, locked.id, AS_OF, ZONE, sender, NOW),
      refused("saved_places"),
    );
    await assert.rejects(
      () => pushAlertEpisodes(sql, open.id, AS_OF, ZONE, sender, NOW),
      refused("alerts"),
    );

    assert.equal(sender.sent.length, 0);
    assert.equal(await countOf(sql, "alert_push"), 0);
    assert.equal(await countOf(sql, "push_delivery"), 0);
  });

  it("records a failed send and retries it once on the next run", async () => {
    const sql = await openDb();
    await grantPro(sql, "user-a");
    const place = await boise(sql, "user-a");
    await seedSmoke(sql, "user-a", place.id, 148, { hours: 4 });
    await seedOfficial(sql, "user-a", place.id, 200);
    const sender = new TestPushSender();
    sender.failNext = true;

    const first = await pushAlertEpisodes(sql, place.id, AS_OF, ZONE, sender, NOW);
    assert.equal(first.sent.length, 0);
    assert.equal(first.failed.length, 1);
    assert.equal(sender.sent.length, 0);
    const failed = first.failed[0];
    assert.ok(failed);
    assert.equal(failed.status, "failed");
    numbersStayApart(failed.payload, 148, 200);
    const failedRows = await sql.query<{ status: string; error_text: string; payload: PushPayload }>(
      "select status, error_text, payload from alert_push",
    );
    assert.equal(failedRows.length, 1);
    assert.equal(failedRows[0]?.status, "failed");
    assert.equal(failedRows[0]?.error_text, "test sender refused");
    assert.ok(failedRows[0]);
    numbersStayApart(failedRows[0].payload, 148, 200);

    const second = await pushAlertEpisodes(sql, place.id, AS_OF, ZONE, sender, NOW);
    assert.equal(second.sent.length, 1);
    assert.equal(second.failed.length, 0);
    assert.equal(second.sent[0]?.id, failed.id);
    assert.equal(sender.sent.length, 1);
    numbersStayApart(sender.sent[0] as PushPayload, 148, 200);
    const sentRows = await sql.query<{ id: string; status: string }>(
      "select id, status from alert_push",
    );
    assert.equal(sentRows.length, 1);
    assert.equal(sentRows[0]?.status, "sent");
    assert.equal(sentRows[0]?.id, failed.id);

    const third = await pushAlertEpisodes(sql, place.id, AS_OF, ZONE, sender, NOW);
    assert.equal(third.sent.length, 0);
    assert.equal(third.skipped, 1);
    assert.equal(sender.sent.length, 1);
    assert.equal(await countOf(sql, "alert_push"), 1);
  });

  it("refuses a non-test sender before it writes", async () => {
    const sql = await openDb();
    await grantPro(sql, "user-a");
    const place = await boise(sql, "user-a");
    await seedSmoke(sql, "user-a", place.id, 148, { hours: 4 });
    let calls = 0;
    const apns: PushSender = {
      name: "apns",
      async send() {
        calls += 1;
        return { ok: true, providerId: "nope" };
      },
    };
    await assert.rejects(
      () => pushAlertEpisodes(sql, place.id, AS_OF, ZONE, apns, NOW),
      (err: unknown) => {
        assert.equal(err instanceof Error && "code" in err && err.code, "push_sender_is_test_only");
        return true;
      },
    );
    assert.equal(calls, 0);
    assert.equal(await countOf(sql, "alert_push"), 0);
    assert.equal(await countOf(sql, "push_delivery"), 0);
  });

  it("writes nothing when a Pro place has no episode", async () => {
    const sql = await openDb();
    await grantPro(sql, "user-a");
    const place = await boise(sql, "user-a");
    const sender = new TestPushSender();
    const result: AlertPushResult = await pushAlertEpisodes(
      sql,
      place.id,
      AS_OF,
      ZONE,
      sender,
      NOW,
    );
    assert.deepEqual(result.sent, []);
    assert.deepEqual(result.failed, []);
    assert.equal(result.skipped, 0);
    assert.equal(sender.sent.length, 0);
    assert.equal(await countOf(sql, "alert_push"), 0);
  });

  it("sends once when two calls overlap on the same episode", async () => {
    const sql = await openDb();
    await grantPro(sql, "user-a");
    const place = await boise(sql, "user-a");
    await seedSmoke(sql, "user-a", place.id, 148, { hours: 4 });
    await seedOfficial(sql, "user-a", place.id, 200);
    const gate = holdSend();
    const first = pushAlertEpisodes(sql, place.id, AS_OF, ZONE, gate.sender, NOW);
    let second: AlertPushResult | undefined;
    try {
      await waitForSend(gate.entered);
      assert.equal(gate.sends(), 1);
      assert.equal(await countOf(sql, "alert_push"), 1);
      second = await pushAlertEpisodes(sql, place.id, AS_OF, ZONE, gate.sender, NOW);
      assert.equal(gate.sends(), 1);
      assert.equal(second.sent.length, 0);
      assert.equal(second.failed.length, 0);
      assert.equal(second.skipped, 1);
      assert.equal(await countOf(sql, "alert_push"), 1);
    } finally {
      gate.release();
    }
    const firstResult = await first;
    assert.ok(second);
    assert.equal(firstResult.sent.length, 1);
    assert.equal(firstResult.failed.length, 0);
    assert.equal(gate.sends(), 1);
    const won = firstResult.sent[0];
    assert.ok(won);
    assert.equal(won.status, "sent");
    numbersStayApart(won.payload, 148, 200);
    const stored = await sql.query<{ status: string; payload: PushPayload }>(
      "select status, payload from alert_push",
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.status, "sent");
    assert.ok(stored[0]);
    numbersStayApart(stored[0].payload, 148, 200);
    assert.equal(await countOf(sql, "push_delivery"), 0);

    const later = new TestPushSender();
    const third = await pushAlertEpisodes(sql, place.id, AS_OF, ZONE, later, NOW);
    assert.equal(third.sent.length, 0);
    assert.equal(third.failed.length, 0);
    assert.equal(third.skipped, 1);
    assert.equal(later.sent.length, 0);
    assert.equal(gate.sends(), 1);
  });

  it("retries a failed episode once when two calls overlap", async () => {
    const sql = await openDb();
    await grantPro(sql, "user-a");
    const place = await boise(sql, "user-a");
    await seedSmoke(sql, "user-a", place.id, 148, { hours: 4 });
    await seedOfficial(sql, "user-a", place.id, 200);
    const failing = new TestPushSender();
    failing.failNext = true;
    const failed = await pushAlertEpisodes(sql, place.id, AS_OF, ZONE, failing, NOW);
    assert.equal(failed.sent.length, 0);
    assert.equal(failed.failed.length, 1);
    assert.equal(failing.sent.length, 0);
    const failedId = failed.failed[0]?.id;
    assert.ok(failedId);

    const gate = holdSend();
    const first = pushAlertEpisodes(sql, place.id, AS_OF, ZONE, gate.sender, NOW);
    let second: AlertPushResult | undefined;
    try {
      await waitForSend(gate.entered);
      assert.equal(gate.sends(), 1);
      assert.equal(await countOf(sql, "alert_push"), 1);
      second = await pushAlertEpisodes(sql, place.id, AS_OF, ZONE, gate.sender, NOW);
      assert.equal(gate.sends(), 1);
      assert.equal(second.sent.length, 0);
      assert.equal(second.failed.length, 0);
      assert.equal(second.skipped, 1);
    } finally {
      gate.release();
    }
    const firstResult = await first;
    assert.ok(second);
    assert.equal(firstResult.sent.length, 1);
    assert.equal(firstResult.failed.length, 0);
    assert.equal(gate.sends(), 1);
    const retried = firstResult.sent[0];
    assert.ok(retried);
    assert.equal(retried.id, failedId);
    numbersStayApart(retried.payload, 148, 200);
    const stored = await sql.query<{ id: string; status: string }>(
      "select id, status from alert_push",
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.id, failedId);
    assert.equal(stored[0]?.status, "sent");

    const later = new TestPushSender();
    const third = await pushAlertEpisodes(sql, place.id, AS_OF, ZONE, later, NOW);
    assert.equal(third.sent.length, 0);
    assert.equal(third.skipped, 1);
    assert.equal(later.sent.length, 0);
    assert.equal(await countOf(sql, "alert_push"), 1);
  });
});
