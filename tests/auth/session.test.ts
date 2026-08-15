import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_RENEWAL_THRESHOLD_MS,
  SESSION_TTL_MS,
  createSession,
  deleteExpiredSessions,
  hashSessionToken,
  invalidateAllUserSessions,
  invalidateSession,
  validateSessionToken,
} from "@/lib/auth/session";
import { createUser } from "@/lib/auth/users";
import { sessions, users } from "@/lib/db/schema";
import { resetDatabase, testDb } from "../setup/db";

async function makeUser(email = "student@example.com") {
  return createUser(testDb, {
    email,
    password: "s3cret-password",
    displayName: "Student One",
  });
}

beforeEach(async () => {
  await resetDatabase();
});

describe("createSession", () => {
  it("returns a token that is never stored verbatim", async () => {
    const user = await makeUser();
    const { token } = await createSession(testDb, user.id);

    const rows = await testDb.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(token);
    expect(rows[0]!.id).toBe(hashSessionToken(token));
  });

  it("issues a distinct token per call", async () => {
    const user = await makeUser();
    const a = await createSession(testDb, user.id);
    const b = await createSession(testDb, user.id);
    expect(a.token).not.toBe(b.token);
  });

  it("sets the expiry to the configured TTL", async () => {
    const user = await makeUser();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const { session } = await createSession(testDb, user.id, { now });
    expect(session.expiresAt.getTime()).toBe(now.getTime() + SESSION_TTL_MS);
  });
});

describe("validateSessionToken", () => {
  it("resolves a valid token to its session and user", async () => {
    const user = await makeUser();
    const { token } = await createSession(testDb, user.id);

    const result = await validateSessionToken(testDb, token);
    expect(result.user?.id).toBe(user.id);
    expect(result.session).not.toBeNull();
    // The user object handed to the app must never carry the hash.
    expect(result.user).not.toHaveProperty("passwordHash");
  });

  it("carries the role from the database, which is the only source of truth", async () => {
    const teacher = await createUser(testDb, {
      email: "teacher@example.com",
      password: "s3cret-password",
      displayName: "Teacher",
      role: "teacher",
    });
    const { token } = await createSession(testDb, teacher.id);

    const result = await validateSessionToken(testDb, token);
    expect(result.user?.role).toBe("teacher");
  });

  it("rejects an unknown token", async () => {
    const result = await validateSessionToken(testDb, "made-up-token");
    expect(result.session).toBeNull();
    expect(result.user).toBeNull();
  });

  it("rejects a token whose session has expired, and deletes the row", async () => {
    const user = await makeUser();
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const { token } = await createSession(testDb, user.id, { now: createdAt });

    const afterExpiry = new Date(createdAt.getTime() + SESSION_TTL_MS + 1_000);
    const result = await validateSessionToken(testDb, token, {
      now: afterExpiry,
    });

    expect(result.session).toBeNull();
    expect(result.user).toBeNull();
    expect(await testDb.select().from(sessions)).toHaveLength(0);
  });

  it("extends a session that is close to expiring", async () => {
    const user = await makeUser();
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const { token, session } = await createSession(testDb, user.id, {
      now: createdAt,
    });

    const nearExpiry = new Date(
      session.expiresAt.getTime() - SESSION_RENEWAL_THRESHOLD_MS + 1_000,
    );
    const result = await validateSessionToken(testDb, token, {
      now: nearExpiry,
    });

    expect(result.session!.expiresAt.getTime()).toBe(
      nearExpiry.getTime() + SESSION_TTL_MS,
    );
  });

  it("does not extend a session that is still fresh", async () => {
    const user = await makeUser();
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const { token, session } = await createSession(testDb, user.id, {
      now: createdAt,
    });

    const result = await validateSessionToken(testDb, token, {
      now: new Date(createdAt.getTime() + 60_000),
    });

    expect(result.session!.expiresAt.getTime()).toBe(
      session.expiresAt.getTime(),
    );
  });
});

describe("session invalidation", () => {
  it("logs a single session out", async () => {
    const user = await makeUser();
    const { token } = await createSession(testDb, user.id);

    await invalidateSession(testDb, token);

    const result = await validateSessionToken(testDb, token);
    expect(result.session).toBeNull();
  });

  it("logs every session of a user out", async () => {
    const user = await makeUser();
    const a = await createSession(testDb, user.id);
    const b = await createSession(testDb, user.id);

    await invalidateAllUserSessions(testDb, user.id);

    expect((await validateSessionToken(testDb, a.token)).session).toBeNull();
    expect((await validateSessionToken(testDb, b.token)).session).toBeNull();
  });

  it("removes sessions when the user is deleted", async () => {
    const user = await makeUser();
    await createSession(testDb, user.id);

    await testDb.delete(users).where(eq(users.id, user.id));

    expect(await testDb.select().from(sessions)).toHaveLength(0);
  });
});

describe("deleteExpiredSessions", () => {
  it("purges only the expired rows", async () => {
    const user = await makeUser();
    const old = new Date("2026-01-01T00:00:00.000Z");
    await createSession(testDb, user.id, { now: old });
    const fresh = await createSession(testDb, user.id, { now: new Date() });

    const removed = await deleteExpiredSessions(
      testDb,
      new Date(old.getTime() + SESSION_TTL_MS + 1_000),
    );

    expect(removed).toBe(1);
    const rows = await testDb.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(hashSessionToken(fresh.token));
  });
});
