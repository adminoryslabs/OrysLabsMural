import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { TEST_DATABASE_URL } from "../setup/test-env";

/**
 * Regression guard for a production outage.
 *
 * `db` is a Proxy that resolves the pool on EVERY property access. When the
 * resolver was not cached, each access opened another pool of 10 sockets and
 * PostgreSQL ran out of connection slots after a few dozen page loads. The
 * error surfaced as "remaining connection slots are reserved for roles with the
 * SUPERUSER attribute", nowhere near the cause.
 *
 * Development never reproduced it: the cache existed, but only on the
 * development branch of the resolver.
 */
describe("the application database handle", () => {
  let observer: ReturnType<typeof postgres>;

  beforeAll(() => {
    vi.stubEnv("DATABASE_URL", TEST_DATABASE_URL);
    // The leak lived behind `NODE_ENV === "production"`, so a test running as
    // "test" would have passed against the broken code. Exercise the branch
    // that actually failed. `vi.stubEnv` rather than assignment: NODE_ENV is
    // typed read-only, and assigning it fails `tsc --noEmit`.
    vi.stubEnv("NODE_ENV", "production");
    // A separate client, so counting does not disturb what is being counted.
    observer = postgres(TEST_DATABASE_URL, { max: 1 });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await observer.end({ timeout: 5 });
  });

  async function backendCount(): Promise<number> {
    const rows = await observer<{ n: number }[]>`
      select count(*)::int as n
      from pg_stat_activity
      where datname = current_database()
    `;
    return rows[0]?.n ?? 0;
  }

  it("opens one pool no matter how many times it is touched", async () => {
    const { db } = await import("@/lib/db");

    // Touch it once so the pool exists, and let it settle.
    await db.execute("select 1");
    const before = await backendCount();

    // Every one of these goes through the proxy's `get` trap.
    for (let i = 0; i < 40; i += 1) {
      await db.execute("select 1");
    }

    const after = await backendCount();

    // A pool may open sockets lazily up to its own `max`, so allow that much
    // slack — but 40 accesses must not create 40 pools.
    expect(after - before).toBeLessThanOrEqual(10);
  });

  it("resolves to the same instance on repeated imports", async () => {
    const first = await import("@/lib/db");
    const second = await import("@/lib/db");
    expect(first.db).toBe(second.db);
    expect(globalThis.__muralDb).toBeDefined();
  });
});
