import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import pg, { type ClientConfig } from "pg";

import { V1RuleError } from "./errors.ts";
import { SAMPLE_PLACE } from "./samples.ts";
import { addSavedPlace } from "./store.ts";
import type { Queryable } from "./types.ts";

/**
 * Saved-place race against real Postgres. `npm test` does not run this file.
 *
 * Admin connection: `AQI_TEST_DATABASE_URL`, or `AQI_TEST_PGHOST` /
 * `AQI_TEST_PGPORT` / `AQI_TEST_PGUSER` / `AQI_TEST_PGPASSWORD` /
 * `AQI_TEST_PGDATABASE`. Unset fields use the local socket (`/tmp`, port 5432,
 * current OS user, database `postgres`). The suite creates and drops a scratch
 * database. The role needs CREATEDB and visibility of `pg_stat_activity`.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function fieldConfig(database: string): ClientConfig {
  const host = process.env.AQI_TEST_PGHOST?.trim() || "/tmp";
  const portText = process.env.AQI_TEST_PGPORT?.trim();
  const port = portText ? Number(portText) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`AQI_TEST_PGPORT must be an integer from 1 to 65535, got ${portText}`);
  }
  const user = process.env.AQI_TEST_PGUSER?.trim() || userInfo().username;
  const password = process.env.AQI_TEST_PGPASSWORD;
  const config: ClientConfig = { host, port, user, database };
  if (password) config.password = password;
  return config;
}

function adminConfig(): ClientConfig {
  const url = process.env.AQI_TEST_DATABASE_URL?.trim();
  if (url) return { connectionString: url };
  return fieldConfig(process.env.AQI_TEST_PGDATABASE?.trim() || "postgres");
}

/** Swap the URI database name. WHATWG URL rejects socket URIs with an empty host. */
function replaceDatabaseName(connectionString: string, database: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error("scratch database name must be letters, digits, and underscores");
  }
  const match = connectionString.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?]*)(?:\/[^?]*)?(\?.*)?$/i);
  if (!match?.[1]) {
    throw new Error("AQI_TEST_DATABASE_URL must be a postgres connection URI");
  }
  return `${match[1]}/${database}${match[2] ?? ""}`;
}

function scratchConfig(database: string): ClientConfig {
  const url = process.env.AQI_TEST_DATABASE_URL?.trim();
  if (!url) return fieldConfig(database);
  return { connectionString: replaceDatabaseName(url, database) };
}

function clientSql(client: pg.Client): Queryable {
  return {
    query: async <T>(text: string, params: unknown[] = []) => {
      const result = await client.query(text, params);
      return result.rows as T[];
    },
  };
}

async function withPostgres(
  fn: (connect: () => Promise<pg.Client>) => Promise<void>,
): Promise<void> {
  const dbName = `aqi_cap_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client(adminConfig());
  await admin.connect();
  const clients: pg.Client[] = [];
  let created = false;
  try {
    await admin.query(`create database ${dbName}`);
    created = true;
    const connect = async (): Promise<pg.Client> => {
      const client = new pg.Client(scratchConfig(dbName));
      await client.connect();
      await client.query("set statement_timeout = '15s'");
      clients.push(client);
      return client;
    };
    const files = readdirSync(join(root, "migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const migrate = await connect();
    for (const name of files) {
      await migrate.query(readFileSync(join(root, "migrations", name), "utf8"));
    }
    await fn(connect);
  } finally {
    await Promise.all(
      clients.map(async (client) => {
        try {
          await client.end();
        } catch {
          // Drop below uses FORCE if a session is still open.
        }
      }),
    );
    if (created) {
      await admin.query(`drop database if exists ${dbName} with (force)`);
    }
    await admin.end();
  }
}

async function waitForCount(
  connect: () => Promise<pg.Client>,
  sql: string,
  params: unknown[],
  want: number,
): Promise<number> {
  const watch = await connect();
  const deadline = Date.now() + 8_000;
  let seen = 0;
  while (Date.now() < deadline) {
    const rows = await watch.query<{ n: number }>(sql, params);
    seen = Number(rows.rows[0]?.n ?? 0);
    if (seen >= want) return seen;
    await delay(20);
  }
  return seen;
}

function waitForAdvisory(connect: () => Promise<pg.Client>, want: number): Promise<number> {
  return waitForCount(
    connect,
    `select count(*)::int as n from pg_stat_activity
     where pid <> pg_backend_pid()
       and datname = current_database()
       and wait_event_type = 'Lock'
       and wait_event = 'advisory'`,
    [],
    want,
  );
}

function waitForQuery(connect: () => Promise<pg.Client>, needle: string): Promise<number> {
  return waitForCount(
    connect,
    `select count(*)::int as n from pg_stat_activity
     where pid <> pg_backend_pid()
       and datname = current_database()
       and wait_event = 'advisory'
       and query like $1`,
    [`%${needle}%`],
    1,
  );
}

describe("AQI_TEST_DATABASE_URL", () => {
  it("keeps the authority and query when it swaps the database", () => {
    assert.equal(
      replaceDatabaseName("postgres://app@127.0.0.1:5432/postgres?sslmode=disable", "aqi_cap_ab"),
      "postgres://app@127.0.0.1:5432/aqi_cap_ab?sslmode=disable",
    );
    assert.equal(
      replaceDatabaseName("postgresql://user@/postgres?host=/tmp", "aqi_cap_ab"),
      "postgresql://user@/aqi_cap_ab?host=/tmp",
    );
  });
});

describe("v1 week 1 postgres", { concurrency: 1 }, () => {
  it("keeps five saved places when two connections race the next add", async () => {
    await withPostgres(async (connect) => {
      const setup = await connect();
      for (let i = 0; i < 4; i += 1) {
        await addSavedPlace(clientSql(setup), "user-a", {
          ...SAMPLE_PLACE,
          name: `Place ${i + 1}`,
          latitude: 43 + i / 10,
        });
      }

      // Hold the same per-user lock the insert takes, so both adds sit inside
      // the cap check together. Sequential runs never hit the race.
      const gate = await connect();
      await gate.query("begin");
      await gate.query("select pg_advisory_xact_lock(hashtext('saved_place'), hashtext($1))", [
        "user-a",
      ]);
      const left = await connect();
      const right = await connect();
      const pending = Promise.allSettled([
        addSavedPlace(clientSql(left), "user-a", {
          ...SAMPLE_PLACE,
          name: "Place 5",
          latitude: 43.5,
        }),
        addSavedPlace(clientSql(right), "user-a", {
          ...SAMPLE_PLACE,
          name: "Place 6",
          latitude: 43.6,
        }),
      ]);
      try {
        const waiters = await waitForAdvisory(connect, 2);
        assert.ok(waiters >= 2);
      } finally {
        await gate.query("rollback");
      }
      const settled = await pending;
      const saved = settled.filter((row) => row.status === "fulfilled");
      const refused = settled.filter((row) => row.status === "rejected");
      assert.equal(saved.length, 1);
      assert.equal(refused.length, 1);
      const refusal = refused[0];
      assert.ok(refusal?.status === "rejected");
      assert.ok(refusal.reason instanceof V1RuleError && refusal.reason.code === "place_cap");
      const counted = await setup.query<{ n: number }>(
        "select count(*)::int as n from saved_place where user_id = 'user-a'",
      );
      assert.equal(counted.rows[0]?.n, 5);

      // Raw inserts skip saved_place_add. The trigger has to serialize too:
      // the fifth stays uncommitted while the sixth is already inside the count.
      for (let i = 0; i < 4; i += 1) {
        await addSavedPlace(clientSql(setup), "user-b", {
          ...SAMPLE_PLACE,
          name: `Other ${i + 1}`,
          latitude: 44 + i / 10,
        });
      }
      const fifth = await connect();
      const sixth = await connect();
      await fifth.query("begin");
      await fifth.query(
        `insert into saved_place (id, user_id, name, latitude, longitude, position)
         values ('race-fifth', 'user-b', 'Other 5', 44.5, -116.2, 5)`,
      );
      let sixthFinished = false;
      const sixthInsert = sixth
        .query(
          `insert into saved_place (id, user_id, name, latitude, longitude, position)
           values ('race-sixth', 'user-b', 'Other 6', 44.6, -116.2, 6)`,
        )
        .then(
          () => {
            sixthFinished = true;
            return null;
          },
          (err: unknown) => {
            sixthFinished = true;
            return err;
          },
        );
      const blocked = await waitForQuery(connect, "race-sixth");
      assert.equal(blocked, 1);
      assert.equal(sixthFinished, false);
      await fifth.query("commit");
      const sixthResult = await sixthInsert;
      assert.ok(sixthResult instanceof Error);
      assert.match(sixthResult.message, /saved places cap is 5/);
      const other = await setup.query<{ n: number }>(
        "select count(*)::int as n from saved_place where user_id = 'user-b'",
      );
      assert.equal(other.rows[0]?.n, 5);
    });
  });
});
