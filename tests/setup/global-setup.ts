import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  TEST_DATABASE_URL,
  adminConnectionString,
  testDatabaseName,
} from "./test-env";

/**
 * Recreates the test database from scratch and applies the real migrations.
 * The suite runs against a genuine Postgres 17 instance (docker compose up -d);
 * nothing about the database layer is mocked.
 */
export async function setup() {
  const name = testDatabaseName();
  const admin = postgres(adminConnectionString(), { max: 1 });
  try {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } catch (error) {
    throw new Error(
      `Could not prepare the test database "${name}". Is Postgres running? ` +
        `Try \`docker compose up -d\`. Original error: ${String(error)}`,
    );
  } finally {
    await admin.end();
  }

  const client = postgres(TEST_DATABASE_URL, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  } finally {
    await client.end();
  }
}
