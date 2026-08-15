import { inArray, or } from "drizzle-orm";
import { findUserById, normalizeEmail } from "@/lib/auth/users";
import type { Database } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { canAdministerBoard } from "./authority";
import {
  addBoardMembers,
  getBoardById,
  removeBoardMembers,
} from "./queries";

/**
 * BATCH MEMBERSHIP.
 *
 * Assigning twenty-five students one dropdown at a time is unusable in front of
 * a class, so the teacher panel works on sets: a multi-selection, or a pasted
 * list of addresses from the course roster.
 *
 * Two rules shape everything here:
 *
 *  1. ONE BAD ADDRESS MUST NOT COST THE BATCH. A typo in an email is the normal
 *     case, not an exception. Every input is classified and reported back
 *     (added / already a member / unknown) and the rest still goes through.
 *  2. AUTHORISATION IS RE-READ FROM THE DATABASE, HERE. These functions do not
 *     trust the caller to have checked: they load the board and the actor's
 *     role themselves and run the same `canAdministerBoard` rule as everything
 *     else. A server action is a public HTTP endpoint.
 */

/** Refusal to administer a board. Distinct from "the input was malformed". */
export class MembershipAuthorizationError extends Error {
  constructor(message = "You are not allowed to administer this board.") {
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

export interface BatchMembershipInput {
  boardId: string;
  /** The user performing the action, as identified by their session. */
  actorId: string;
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

/** Loads the board and the actor, and refuses anyone who may not administer it. */
async function authorize(db: Database, input: BatchMembershipInput) {
  const board = await getBoardById(db, input.boardId);
  if (!board) {
    throw new Error("The board does not exist.");
  }
  const actor = await findUserById(db, input.actorId);
  if (!actor || !canAdministerBoard({ board, user: actor })) {
    throw new MembershipAuthorizationError();
  }
  return board;
}

interface Resolved {
  targets: MemberSummary[];
  unknownEmails: string[];
  unknownUserIds: string[];
}

/** Turns a mixed list of ids and addresses into accounts, one query. */
async function resolveTargets(
  db: Database,
  input: BatchMembershipInput,
): Promise<Resolved> {
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

function split(
  targets: MemberSummary[],
  appliedIds: readonly string[],
): Pick<MembershipBatchResult, "applied" | "skipped"> {
  const applied = new Set(appliedIds);
  return {
    applied: targets.filter((row) => applied.has(row.id)).sort(byDisplayName),
    skipped: targets.filter((row) => !applied.has(row.id)).sort(byDisplayName),
  };
}

export async function addBoardMembersBatch(
  db: Database,
  input: BatchMembershipInput,
): Promise<MembershipBatchResult> {
  await authorize(db, input);
  const { targets, unknownEmails, unknownUserIds } = await resolveTargets(
    db,
    input,
  );

  const inserted = await addBoardMembers(
    db,
    input.boardId,
    targets.map((row) => row.id),
  );

  return { ...split(targets, inserted), unknownEmails, unknownUserIds };
}

export async function removeBoardMembersBatch(
  db: Database,
  input: BatchMembershipInput,
): Promise<MembershipBatchResult> {
  await authorize(db, input);
  const { targets, unknownEmails, unknownUserIds } = await resolveTargets(
    db,
    input,
  );

  const deleted = await removeBoardMembers(
    db,
    input.boardId,
    targets.map((row) => row.id),
  );

  return { ...split(targets, deleted), unknownEmails, unknownUserIds };
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
