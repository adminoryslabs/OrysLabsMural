import { findUserById } from "@/lib/auth/users";
import type { Database } from "@/lib/db";
import {
  MembershipAuthorizationError,
  resolveTargets,
  splitApplied,
  type MembershipBatchResult,
} from "@/lib/members/batch";
import { canAdministerClassroom } from "./authority";
import {
  addClassroomMembers,
  getClassroomById,
  removeClassroomMembers,
} from "./queries";

/**
 * CLASSROOM MEMBERSHIP IN BATCHES.
 *
 * The same machinery the board screen uses (`lib/members/batch.ts`), pointed at
 * the cohort instead of at one board — because this IS the assignment screen
 * now. Adding a student here grants every board of the classroom at once, and
 * removing them revokes every one of them at once.
 *
 * Authorisation is re-read from the database here, exactly as on boards: these
 * functions load the classroom and the actor's role themselves and run
 * `canAdministerClassroom` for themselves. A server action is a public HTTP
 * endpoint and the caller having "already checked" proves nothing.
 */

export interface ClassroomBatchInput {
  classroomId: string;
  /** The user performing the action, as identified by their session. */
  actorId: string;
  userIds?: readonly string[];
  emails?: readonly string[];
}

async function authorize(db: Database, input: ClassroomBatchInput) {
  const classroom = await getClassroomById(db, input.classroomId);
  if (!classroom) {
    throw new Error("The classroom does not exist.");
  }
  const actor = await findUserById(db, input.actorId);
  if (!actor || !canAdministerClassroom({ classroom, user: actor })) {
    throw new MembershipAuthorizationError(
      "You are not allowed to administer this classroom.",
    );
  }
  return classroom;
}

export async function addClassroomMembersBatch(
  db: Database,
  input: ClassroomBatchInput,
): Promise<MembershipBatchResult> {
  await authorize(db, input);
  const { targets, unknownEmails, unknownUserIds } = await resolveTargets(
    db,
    input,
  );

  const inserted = await addClassroomMembers(
    db,
    input.classroomId,
    targets.map((row) => row.id),
  );

  return { ...splitApplied(targets, inserted), unknownEmails, unknownUserIds };
}

export async function removeClassroomMembersBatch(
  db: Database,
  input: ClassroomBatchInput,
): Promise<MembershipBatchResult> {
  await authorize(db, input);
  const { targets, unknownEmails, unknownUserIds } = await resolveTargets(
    db,
    input,
  );

  const deleted = await removeClassroomMembers(
    db,
    input.classroomId,
    targets.map((row) => row.id),
  );

  return { ...splitApplied(targets, deleted), unknownEmails, unknownUserIds };
}
