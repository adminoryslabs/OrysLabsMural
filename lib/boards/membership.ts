import { findUserById } from "@/lib/auth/users";
import type { Database } from "@/lib/db";
import {
  MembershipAuthorizationError,
  resolveTargets,
  splitApplied,
  type MembershipBatchResult,
} from "@/lib/members/batch";
import { canAdministerBoard } from "./authority";
import { addBoardMembers, getBoardById, removeBoardMembers } from "./queries";

/**
 * EXPLICIT BOARD MEMBERSHIP — the additive exception.
 *
 * Since classrooms exist, this is no longer how a class is assigned: a board
 * belongs to a classroom, and the classroom's roster is what grants access. A
 * row here is the escape hatch on top of that — a teaching assistant, a guest,
 * a student sitting in on one exercise. It only ever ADDS: removing someone
 * here does not take away access their classroom gives them.
 *
 * The batch machinery (parsing, resolution, classification, wording) lives in
 * `lib/members/batch.ts` and is shared with classrooms. What stays here is the
 * one thing that is board-specific: AUTHORISATION IS RE-READ FROM THE DATABASE.
 * These functions do not trust the caller to have checked. They load the board
 * and the actor's role themselves and run the same `canAdministerBoard` rule as
 * everything else, because a server action is a public HTTP endpoint.
 */

export {
  MAX_BATCH_SIZE,
  MembershipAuthorizationError,
  describeBatchResult,
  parseEmailList,
} from "@/lib/members/batch";
export type {
  MemberSummary,
  MembershipBatchResult,
} from "@/lib/members/batch";

export interface BatchMembershipInput {
  boardId: string;
  /** The user performing the action, as identified by their session. */
  actorId: string;
  userIds?: readonly string[];
  emails?: readonly string[];
}

/** Loads the board and the actor, and refuses anyone who may not administer it. */
async function authorize(db: Database, input: BatchMembershipInput) {
  const board = await getBoardById(db, input.boardId);
  if (!board) {
    throw new Error("The board does not exist.");
  }
  const actor = await findUserById(db, input.actorId);
  if (!actor || !canAdministerBoard({ board, user: actor })) {
    throw new MembershipAuthorizationError(
      "You are not allowed to administer this board.",
    );
  }
  return board;
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

  return { ...splitApplied(targets, inserted), unknownEmails, unknownUserIds };
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

  return { ...splitApplied(targets, deleted), unknownEmails, unknownUserIds };
}
