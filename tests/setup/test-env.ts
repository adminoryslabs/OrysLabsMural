import "dotenv/config";

/**
 * Connection string for the test database. Defaults to the local docker compose
 * Postgres so `npm test` works right after `docker compose up -d`.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://mural:mural_dev_password@localhost:5433/mural_test";

/** Same server, but the maintenance database, used to (re)create the test one. */
export function adminConnectionString(): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = "/postgres";
  return url.toString();
}

export function testDatabaseName(): string {
  return new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "");
}
