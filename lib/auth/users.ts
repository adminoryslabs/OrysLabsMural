import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { users, type User, type UserRole } from "@/lib/db/schema";
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from "./password";

/** Public shape of a user: everything except the password hash. */
export type PublicUser = Omit<User, "passwordHash">;

const PUBLIC_USER_COLUMNS = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  role: users.role,
  createdAt: users.createdAt,
} as const;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toPublicUser(user: User): PublicUser {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}

export interface CreateUserInput {
  email: string;
  password: string;
  displayName: string;
  role?: UserRole;
}

/**
 * Creates an account. There is no public signup: this is only reachable from the
 * seed script and from teacher-only server actions.
 */
export async function createUser(
  db: Database,
  input: CreateUserInput,
): Promise<User> {
  const email = normalizeEmail(input.email);
  const displayName = input.displayName.trim();

  if (!email.includes("@")) {
    throw new Error("A valid email address is required.");
  }
  if (displayName.length === 0) {
    throw new Error("A display name is required.");
  }
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `The password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    );
  }

  const passwordHash = await hashPassword(input.password);
  const [created] = await db
    .insert(users)
    .values({ email, passwordHash, displayName, role: input.role ?? "student" })
    .returning();

  if (!created) {
    throw new Error("The user could not be created.");
  }
  return created;
}

export async function findUserByEmail(
  db: Database,
  email: string,
): Promise<User | null> {
  const [found] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  return found ?? null;
}

export async function findUserById(
  db: Database,
  id: string,
): Promise<PublicUser | null> {
  const [found] = await db
    .select(PUBLIC_USER_COLUMNS)
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return found ?? null;
}

/**
 * A dummy argon2id hash of a random string. Verifying against it when the email
 * is unknown keeps the response time of "no such user" close to that of "wrong
 * password", so the login form does not leak which emails exist.
 */
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomUUID());
  return dummyHash;
}

export async function verifyCredentials(
  db: Database,
  email: string,
  password: string,
): Promise<PublicUser | null> {
  const user = await findUserByEmail(db, email);
  if (!user) {
    await verifyPassword(await getDummyHash(), password);
    return null;
  }
  const ok = await verifyPassword(user.passwordHash, password);
  return ok ? toPublicUser(user) : null;
}

export async function listUsers(db: Database): Promise<PublicUser[]> {
  return db
    .select(PUBLIC_USER_COLUMNS)
    .from(users)
    .orderBy(asc(users.role), asc(users.displayName));
}

export async function setUserPassword(
  db: Database,
  userId: string,
  password: string,
): Promise<void> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `The password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    );
  }
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(users.id, userId));
}
