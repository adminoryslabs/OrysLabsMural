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
  // Reused across hot reloads in development so we do not leak pools.
  // eslint-disable-next-line no-var
  var __muralDb: Database | undefined;
}

function resolveDatabase(): Database {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy env.example to .env and start Postgres with `docker compose up -d`.",
    );
  }
  if (process.env.NODE_ENV === "production") {
    return createDatabase(url);
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
