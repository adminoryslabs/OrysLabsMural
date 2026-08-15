import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>;

/**
 * Builds a Drizzle client for an explicit connection string. Used by scripts and
 * by the test suite, which point at their own databases.
 */
export function createDatabase(connectionString: string, max = 10) {
  const client = postgres(connectionString, { max });
  return drizzle(client, { schema });
}

export function createRawClient(connectionString: string, max = 1) {
  return postgres(connectionString, { max });
}

declare global {
  // Reused across hot reloads in development, and across every access to `db`
  // in every environment.
  var __muralDb: Database | undefined;
}

/**
 * Resolves the one connection pool this process owns.
 *
 * It MUST be cached. The `db` proxy below calls this on every property access,
 * so returning a fresh `createDatabase()` opens another pool of `max` sockets
 * each time. Production used to do exactly that and exhausted PostgreSQL's 100
 * connection slots; the failure surfaced as
 * `remaining connection slots are reserved for roles with the SUPERUSER
 * attribute`, far away from the cause. Development never showed it because the
 * cache below was the development-only branch.
 */
function resolveDatabase(): Database {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy env.example to .env and start Postgres with `docker compose up -d`.",
    );
  }
  globalThis.__muralDb ??= createDatabase(url);
  return globalThis.__muralDb;
}

/**
 * Application-wide database handle. Lazily resolved so that importing modules
 * that merely reference types does not require a live connection string.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, prop) {
    const database = resolveDatabase();
    const value = Reflect.get(database, prop) as unknown;
    return typeof value === "function" ? value.bind(database) : value;
  },
});
