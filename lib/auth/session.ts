import { createHash, randomBytes } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { sessions, users, type AuthSession } from "@/lib/db/schema";
import type { PublicUser } from "./users";

const DAY_MS = 24 * 60 * 60 * 1000;

function ttlDaysFromEnv(): number {
  const raw = Number(process.env.SESSION_TTL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

/** Lifetime of a freshly issued session. */
export const SESSION_TTL_MS = ttlDaysFromEnv() * DAY_MS;

/**
 * A session inside this window of its expiry is extended on use, so an active
 * user is never logged out mid-class while an idle one still expires.
 */
export const SESSION_RENEWAL_THRESHOLD_MS = SESSION_TTL_MS / 2;

/** 32 bytes of CSPRNG entropy, base64url encoded. Sent to the browser. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * What is stored in the database. Only the hash is persisted, so a dump of the
 * sessions table cannot be replayed as a login.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionValidationResult {
  session: AuthSession | null;
  user: PublicUser | null;
}

export async function createSession(
  db: Database,
  userId: string,
  options: { now?: Date } = {},
): Promise<{ token: string; session: AuthSession }> {
  const now = options.now ?? new Date();
  const token = generateSessionToken();
  const [session] = await db
    .insert(sessions)
    .values({
      id: hashSessionToken(token),
      userId,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      createdAt: now,
    })
    .returning();

  if (!session) {
    throw new Error("The session could not be created.");
  }
  return { token, session };
}

/**
 * Resolves a cookie token to its session and user. Expired sessions are deleted
 * on sight, and sessions close to expiry are extended.
 *
 * This is the only place that turns a cookie into an identity; every route,
 * server action and (in Phase B) websocket handshake goes through it.
 */
export async function validateSessionToken(
  db: Database,
  token: string,
  options: { now?: Date } = {},
): Promise<SessionValidationResult> {
  const now = options.now ?? new Date();
  const sessionId = hashSessionToken(token);

  const [row] = await db
    .select({
      session: sessions,
      user: {
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        createdAt: users.createdAt,
      },
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (!row) {
    return { session: null, user: null };
  }

  if (row.session.expiresAt.getTime() <= now.getTime()) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return { session: null, user: null };
  }

  let session = row.session;
  if (
    row.session.expiresAt.getTime() - now.getTime() <
    SESSION_RENEWAL_THRESHOLD_MS
  ) {
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const [renewed] = await db
      .update(sessions)
      .set({ expiresAt })
      .where(eq(sessions.id, sessionId))
      .returning();
    session = renewed ?? { ...row.session, expiresAt };
  }

  return { session, user: row.user };
}

export async function invalidateSession(
  db: Database,
  token: string,
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, hashSessionToken(token)));
}

export async function invalidateAllUserSessions(
  db: Database,
  userId: string,
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** Housekeeping: drop rows whose expiry has passed. Returns how many. */
export async function deleteExpiredSessions(
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  const removed = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  return removed.length;
}
