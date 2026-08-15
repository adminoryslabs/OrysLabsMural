import "dotenv/config";
import { createDatabase } from "@/lib/db";
import { consoleLogger } from "./logger";
import { createYjsServer } from "./server";

/**
 * Entrypoint for the collaboration server.
 *
 *   npm run yjs        (development, alongside `npm run dev`)
 *   node --import tsx yjs-server/index.ts   (what the container runs)
 *
 * It is a separate process from Next.js on purpose: websockets are long-lived
 * and stateful, and they must not be restarted by a page recompile.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy env.example to .env before starting the Yjs server.`,
    );
  }
  return value;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const db = createDatabase(requiredEnv("DATABASE_URL"));

  const server = await createYjsServer({
    db,
    host: process.env.YJS_HOST ?? "0.0.0.0",
    port: numberFromEnv("YJS_PORT", 1234),
    snapshotDebounceMs: numberFromEnv("YJS_SNAPSHOT_DEBOUNCE_MS", 2000),
    snapshotHistoryLimit: numberFromEnv("YJS_SNAPSHOT_HISTORY", 20),
    heartbeatIntervalMs: numberFromEnv("YJS_HEARTBEAT_MS", 20_000),
    reaperIntervalMs: numberFromEnv("YJS_REAPER_MS", 60_000),
    staleAfterSeconds: numberFromEnv("YJS_STALE_AFTER_SECONDS", 120),
    logger: consoleLogger,
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    consoleLogger.info(`received ${signal}, closing board sessions`);
    server
      .close()
      .then(() => process.exit(0))
      .catch((error) => {
        consoleLogger.error("shutdown failed", error);
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  consoleLogger.error("the Yjs server could not start", error);
  process.exit(1);
});
