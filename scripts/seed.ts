import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createDatabase } from "@/lib/db";
import {
  createUser,
  findUserByEmail,
  normalizeEmail,
} from "@/lib/auth/users";
import type { UserRole } from "@/lib/db/schema";

/**
 * Provisions the classroom: one teacher plus the student roster.
 *
 * Idempotent: an account that already exists is left untouched (its password is
 * NOT reset, so re-running the script never locks a student out mid-course).
 * Generated passwords are printed once and also written to seed-credentials.csv,
 * which is gitignored.
 *
 *   npm run db:seed
 */

interface RosterEntry {
  displayName: string;
  email: string;
  role: UserRole;
}

const CREDENTIALS_FILE = "seed-credentials.csv";

/** Readable, unambiguous password: no l/1/O/0 confusion when dictated aloud. */
function generatePassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(12);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]!).join("");
}

function parseRoster(csv: string, domain: string): RosterEntry[] {
  const entries: RosterEntry[] = [];

  for (const rawLine of csv.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const [first = "", second = "", third = ""] = line
      .split(",")
      .map((cell) => cell.trim());

    // Skip a header row.
    if (/^(name|display_name|displayname)$/i.test(first)) continue;

    const displayName = first;
    const email = second.includes("@")
      ? normalizeEmail(second)
      : normalizeEmail(`${slug(displayName)}@${domain}`);
    const role: UserRole = third === "teacher" ? "teacher" : "student";

    if (displayName.length === 0) continue;
    entries.push({ displayName, email, role });
  }

  return entries;
}

function slug(value: string): string {
  return value
    .normalize("NFD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");
}

function buildDefaultRoster(count: number, domain: string): RosterEntry[] {
  return Array.from({ length: count }, (_unused, index) => {
    const number = String(index + 1).padStart(2, "0");
    return {
      displayName: `Student ${number}`,
      email: `student${number}@${domain}`,
      role: "student" as const,
    };
  });
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy env.example to .env and start Postgres with `docker compose up -d`.",
    );
  }

  const domain = process.env.SEED_STUDENT_EMAIL_DOMAIN ?? "example.com";
  const rosterFile = process.env.SEED_ROSTER_FILE ?? "scripts/roster.csv";
  const studentCount = Number(process.env.SEED_STUDENT_COUNT ?? 25);

  const roster: RosterEntry[] = [
    {
      displayName: process.env.SEED_TEACHER_NAME ?? "Course Instructor",
      email: normalizeEmail(
        process.env.SEED_TEACHER_EMAIL ?? `teacher@${domain}`,
      ),
      role: "teacher",
    },
    ...(existsSync(rosterFile)
      ? parseRoster(readFileSync(rosterFile, "utf8"), domain)
      : buildDefaultRoster(studentCount, domain)),
  ];

  if (existsSync(rosterFile)) {
    console.log(`Roster source: ${rosterFile}`);
  } else {
    console.log(
      `Roster source: generated (${studentCount} students). Create ${rosterFile} to use real names.`,
    );
  }

  const db = createDatabase(url, 1);
  const created: Array<{ email: string; password: string; role: UserRole }> = [];
  let skipped = 0;

  for (const entry of roster) {
    const existing = await findUserByEmail(db, entry.email);
    if (existing) {
      skipped += 1;
      continue;
    }

    const password =
      entry.role === "teacher" && process.env.SEED_TEACHER_PASSWORD
        ? process.env.SEED_TEACHER_PASSWORD
        : generatePassword();

    await createUser(db, {
      email: entry.email,
      password,
      displayName: entry.displayName,
      role: entry.role,
    });
    created.push({ email: entry.email, password, role: entry.role });
  }

  if (created.length > 0) {
    const csv = [
      "email,password,role",
      ...created.map((row) => `${row.email},${row.password},${row.role}`),
    ].join("\n");
    writeFileSync(CREDENTIALS_FILE, `${csv}\n`, { mode: 0o600 });

    console.log("\nCredentials (shown once, also saved to seed-credentials.csv):\n");
    console.log("email,password,role");
    for (const row of created) {
      console.log(`${row.email},${row.password},${row.role}`);
    }
  }

  console.log(
    `\nDone. Created ${created.length} account(s), left ${skipped} existing account(s) untouched.`,
  );
  if (created.length > 0) {
    console.log(
      `Hand out the credentials, then delete ${CREDENTIALS_FILE}. It is gitignored but it is still plaintext.`,
    );
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
