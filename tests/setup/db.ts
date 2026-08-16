import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";
import { TEST_DATABASE_URL } from "./test-env";

const client = postgres(TEST_DATABASE_URL, { max: 4 });

/** Drizzle handle bound to the real test database. */
export const testDb = drizzle(client, { schema });

/** Wipes every table between tests. Order is handled by CASCADE. */
export async function resetDatabase(): Promise<void> {
  await client.unsafe(
    `TRUNCATE TABLE board_files, board_snapshots, board_sessions, board_members, sessions, boards, users RESTART IDENTITY CASCADE`,
  );
}

export async function closeTestDatabase(): Promise<void> {
  await client.end();
}
