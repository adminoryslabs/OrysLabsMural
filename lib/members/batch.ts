import { inArray, or } from "drizzle-orm";
import { normalizeEmail } from "@/lib/auth/users";
import type { Database } from "@/lib/db";
import { users } from "@/lib/db/schema";

/**
 * BATCH MEMBERSHIP, THE PART THAT IS NOT ABOUT BOARDS.
 *
 * Assigning twenty-five students one dropdown at a time is unusable in front of
 * a class, so every membership screen works on sets: a multi-selection, or a
 * pasted list of addresses from the course roster. Boards and classrooms both
 * do it, and they do it with THIS code — the parsing, the resolution, the
 * classification and the wording exist exactly once, so the two screens cannot
 * drift into behaving differently.
 *
 * The rule that shapes everything here: ONE BAD ADDRESS MUST NOT COST THE
 * BATCH. A typo in an email is the normal case, not an exception. Every input
 * is classified and reported back (added / already there / unknown) and the
 * rest still goes through.
 *
 * Authorisation is deliberately NOT here. It belongs to the caller, because
 * what "may administer" means differs between a board and a classroom, and a
 * generic helper guessing at it is how a hole gets opened.
 */

/** Refusal to administer. Distinct from "the input was malformed". */
export class MembershipAuthorizationError extends Error {
  constructor(message = "You are not allowed to administer this.") {
    super(message);
    this.name = "MembershipAuthorizationError";
  }
}

/** A whole class fits comfortably; this only exists to bound a hostile paste. */
export const MAX_BATCH_SIZE = 500;

export interface MemberSummary {
  id: string;
  email: string;
  displayName: string;
}

export interface MembershipBatchResult {
  /** Memberships this call actually created (or removed). */
  applied: MemberSummary[];
  /** Accounts that were already in the requested state. */
  skipped: MemberSummary[];
  /** Addresses with no account. Reported, never fatal. */
  unknownEmails: string[];
  /** Ids that match no account, e.g. a forged form field. */
  unknownUserIds: string[];
}

export interface BatchTargets {
  userIds?: readonly string[];
  emails?: readonly string[];
}

/**
 * Splits a pasted roster. Accepts newlines, commas, semicolons and stray
 * whitespace in any combination, because that is what a paste from a
 * spreadsheet or an email client actually looks like.
 */
export function parseEmailList(raw: string): string[] {
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const chunk of raw.split(/[\s,;]+/)) {
    const email = normalizeEmail(chunk);
    if (email.length === 0 || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export interface ResolvedTargets {
  targets: MemberSummary[];
  unknownEmails: string[];
  unknownUserIds: string[];
}

/** Turns a mixed list of ids and addresses into accounts, one query. */
export async function resolveTargets(
  db: Database,
  input: BatchTargets,
): Promise<ResolvedTargets> {
  const userIds = dedupe(input.userIds ?? []);
  const emails = dedupe(input.emails ?? []).map(normalizeEmail);

  if (userIds.length + emails.length > MAX_BATCH_SIZE) {
    throw new Error(`A batch is limited to ${MAX_BATCH_SIZE} people.`);
  }
  if (userIds.length + emails.length === 0) {
    return { targets: [], unknownEmails: [], unknownUserIds: [] };
  }

  const conditions = [
    ...(userIds.length > 0 ? [inArray(users.id, userIds)] : []),
    ...(emails.length > 0 ? [inArray(users.email, emails)] : []),
  ];
  const found = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
    })
    .from(users)
    .where(conditions.length === 1 ? conditions[0] : or(...conditions));

  const byId = new Map(found.map((row) => [row.id, row]));
  const byEmail = new Map(found.map((row) => [row.email, row]));

  return {
    targets: found,
    unknownEmails: emails.filter((email) => !byEmail.has(email)),
    unknownUserIds: userIds.filter((id) => !byId.has(id)),
  };
}

function byDisplayName(a: MemberSummary, b: MemberSummary): number {
  return a.displayName.localeCompare(b.displayName);
}

/**
 * Splits the resolved accounts by what the database actually did. The insert
 * and the delete both use `returning`, so "who was already there" is answered
 * by Postgres rather than by a read-then-write two teachers could interleave.
 */
export function splitApplied(
  targets: MemberSummary[],
  appliedIds: readonly string[],
): Pick<MembershipBatchResult, "applied" | "skipped"> {
  const applied = new Set(appliedIds);
  return {
    applied: targets.filter((row) => applied.has(row.id)).sort(byDisplayName),
    skipped: targets.filter((row) => !applied.has(row.id)).sort(byDisplayName),
  };
}

/** One line a teacher can read at a glance, in the panel. */
export function describeBatchResult(
  result: MembershipBatchResult,
  verb: "added" | "removed",
): string {
  const parts = [`${result.applied.length} ${verb}`];
  if (result.skipped.length > 0) {
    parts.push(
      verb === "added"
        ? `${result.skipped.length} already a member`
        : `${result.skipped.length} were not members`,
    );
  }
  if (result.unknownEmails.length > 0) {
    parts.push(`unknown: ${result.unknownEmails.join(", ")}`);
  }
  if (result.unknownUserIds.length > 0) {
    parts.push(`${result.unknownUserIds.length} unknown accounts ignored`);
  }
  return parts.join(" · ");
}
