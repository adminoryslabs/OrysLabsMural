import { beforeEach, describe, expect, it } from "vitest";
import {
  createUser,
  findUserByEmail,
  listUsers,
  normalizeEmail,
  verifyCredentials,
} from "@/lib/auth/users";
import { resetDatabase, testDb } from "../setup/db";

beforeEach(async () => {
  await resetDatabase();
});

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Student.One@Example.COM ")).toBe(
      "student.one@example.com",
    );
  });
});

describe("createUser", () => {
  it("stores a hashed password, never the plaintext", async () => {
    const user = await createUser(testDb, {
      email: "teacher@example.com",
      password: "s3cret-password",
      displayName: "Teacher",
      role: "teacher",
    });

    expect(user.passwordHash).not.toBe("s3cret-password");
    expect(user.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(user.role).toBe("teacher");
  });

  it("defaults the role to student", async () => {
    const user = await createUser(testDb, {
      email: "student@example.com",
      password: "s3cret-password",
      displayName: "Student",
    });
    expect(user.role).toBe("student");
  });

  it("normalizes the email before storing it", async () => {
    await createUser(testDb, {
      email: "  Mixed.Case@Example.com ",
      password: "s3cret-password",
      displayName: "Student",
    });
    const found = await findUserByEmail(testDb, "mixed.case@example.com");
    expect(found?.displayName).toBe("Student");
  });

  it("rejects a duplicate email regardless of casing", async () => {
    await createUser(testDb, {
      email: "dup@example.com",
      password: "s3cret-password",
      displayName: "First",
    });

    await expect(
      createUser(testDb, {
        email: "DUP@example.com",
        password: "another-password",
        displayName: "Second",
      }),
    ).rejects.toThrow();
  });
});

describe("verifyCredentials", () => {
  beforeEach(async () => {
    await createUser(testDb, {
      email: "student@example.com",
      password: "s3cret-password",
      displayName: "Student One",
    });
  });

  it("returns the user for valid credentials", async () => {
    const user = await verifyCredentials(
      testDb,
      "Student@Example.com",
      "s3cret-password",
    );
    expect(user?.displayName).toBe("Student One");
  });

  it("returns null for a wrong password", async () => {
    const user = await verifyCredentials(
      testDb,
      "student@example.com",
      "nope",
    );
    expect(user).toBeNull();
  });

  it("returns null for an unknown email", async () => {
    const user = await verifyCredentials(
      testDb,
      "ghost@example.com",
      "s3cret-password",
    );
    expect(user).toBeNull();
  });
});

describe("listUsers", () => {
  it("lists users without exposing password hashes", async () => {
    await createUser(testDb, {
      email: "a@example.com",
      password: "s3cret-password",
      displayName: "A",
      role: "teacher",
    });
    await createUser(testDb, {
      email: "b@example.com",
      password: "s3cret-password",
      displayName: "B",
    });

    const users = await listUsers(testDb);
    expect(users).toHaveLength(2);
    for (const user of users) {
      expect(user).not.toHaveProperty("passwordHash");
    }
  });
});
