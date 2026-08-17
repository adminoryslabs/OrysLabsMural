"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireTeacher } from "@/lib/auth/current-user";
import type { PublicUser } from "@/lib/auth/users";
import { canAdministerBoard } from "@/lib/boards/authority";
import { getBoardById, setBoardClassroom } from "@/lib/boards/queries";
import {
  canAdministerClassroom,
  canDeleteClassroom,
} from "@/lib/classrooms/authority";
import {
  addClassroomMembersBatch,
  removeClassroomMembersBatch,
} from "@/lib/classrooms/membership";
import {
  DuplicateClassroomNameError,
  MAX_CLASSROOM_NAME_LENGTH,
  createClassroom,
  deleteClassroom,
  getClassroomById,
  renameClassroom,
} from "@/lib/classrooms/queries";
import { db } from "@/lib/db";
import type { Classroom } from "@/lib/db/schema";
import {
  MAX_BATCH_SIZE,
  MembershipAuthorizationError,
  describeBatchResult,
  parseEmailList,
  type MembershipBatchResult,
} from "@/lib/members/batch";
import type { ActionState } from "./actions";

/**
 * CLASSROOM ADMINISTRATION.
 *
 * A classroom grants access to every board assigned to it, so each of these is
 * an access decision and each one re-authenticates from the cookie and
 * re-authorises against the database. The fact that the form was only rendered
 * for teachers proves nothing: a server action is a public HTTP endpoint.
 */

const uuid = z.string().uuid();

async function authorizeClassroomAdmin(classroomId: string): Promise<{
  teacher: PublicUser;
  classroom: Classroom;
}> {
  const teacher = await requireTeacher();
  const classroom = await getClassroomById(db, classroomId);
  if (!classroom) {
    throw new Error("The classroom does not exist.");
  }
  if (!canAdministerClassroom({ classroom, user: teacher })) {
    throw new Error("You are not allowed to administer this classroom.");
  }
  return { teacher, classroom };
}

/** Every screen that can show a classroom's effect on access. */
function revalidateClassroom(classroomId?: string): void {
  revalidatePath("/teacher");
  revalidatePath("/teacher/classrooms");
  if (classroomId) revalidatePath(`/teacher/classrooms/${classroomId}`);
  revalidatePath("/boards");
}

const createClassroomSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "The classroom name is required.")
    .max(MAX_CLASSROOM_NAME_LENGTH),
});

export async function createClassroomAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const teacher = await requireTeacher();
  const parsed = createClassroomSchema.safeParse({
    name: formData.get("name"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid classroom name.",
    };
  }

  try {
    await createClassroom(db, { name: parsed.data.name, ownerId: teacher.id });
  } catch (error) {
    if (error instanceof DuplicateClassroomNameError) {
      return { error: error.message };
    }
    return { error: "The classroom could not be created." };
  }

  revalidateClassroom();
  return { message: "Classroom created." };
}

const renameClassroomSchema = z.object({
  classroomId: uuid,
  name: z.string().trim().min(1).max(MAX_CLASSROOM_NAME_LENGTH),
});

export async function renameClassroomAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = renameClassroomSchema.safeParse({
    classroomId: formData.get("classroomId"),
    name: formData.get("name"),
  });
  if (!parsed.success) {
    return { error: "Invalid classroom name." };
  }

  try {
    await authorizeClassroomAdmin(parsed.data.classroomId);
    await renameClassroom(db, parsed.data.classroomId, parsed.data.name);
  } catch (error) {
    if (error instanceof DuplicateClassroomNameError) {
      return { error: error.message };
    }
    return { error: "The classroom could not be renamed." };
  }

  revalidateClassroom(parsed.data.classroomId);
  return { message: "Classroom renamed." };
}

/**
 * Deleting a cohort does NOT delete its boards: `boards.classroom_id` is
 * `on delete set null`, so they survive as unassigned boards holding only their
 * explicit members. Class material is never destroyed by an access change, and
 * access is never silently widened either.
 */
export async function deleteClassroomAction(formData: FormData): Promise<void> {
  const parsed = z
    .object({ classroomId: uuid })
    .safeParse({ classroomId: formData.get("classroomId") });
  if (!parsed.success) {
    throw new Error("Invalid classroom.");
  }

  const teacher = await requireTeacher();
  const classroom = await getClassroomById(db, parsed.data.classroomId);
  if (!classroom) {
    throw new Error("The classroom does not exist.");
  }
  if (!canDeleteClassroom({ classroom, user: teacher })) {
    throw new Error("Only the teacher who created this classroom can delete it.");
  }

  await deleteClassroom(db, parsed.data.classroomId);
  revalidateClassroom(parsed.data.classroomId);
  redirect("/teacher/classrooms");
}

/**
 * Assigns a board to a cohort, or clears the assignment. An empty value means
 * "no classroom", which returns the board to explicit-membership-only access.
 */
const setBoardClassroomSchema = z.object({
  boardId: uuid,
  classroomId: z.union([uuid, z.literal("")]),
});

export async function setBoardClassroomAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = setBoardClassroomSchema.safeParse({
    boardId: formData.get("boardId"),
    classroomId: String(formData.get("classroomId") ?? ""),
  });
  if (!parsed.success) {
    return { error: "That classroom does not exist." };
  }

  const teacher = await requireTeacher();
  const board = await getBoardById(db, parsed.data.boardId);
  if (!board || !canAdministerBoard({ board, user: teacher })) {
    return { error: "You are not allowed to administer this board." };
  }

  const classroomId = parsed.data.classroomId || null;
  if (classroomId) {
    // Never write a foreign key the caller supplied without proving it exists:
    // the failure would otherwise surface as a raw constraint error.
    const classroom = await getClassroomById(db, classroomId);
    if (!classroom) return { error: "That classroom does not exist." };
  }

  await setBoardClassroom(db, parsed.data.boardId, classroomId);

  revalidateClassroom(classroomId ?? undefined);
  revalidatePath(`/teacher/boards/${parsed.data.boardId}`);
  revalidatePath(`/boards/${parsed.data.boardId}`);
  return {
    message: classroomId
      ? "Board assigned to the classroom."
      : "Board removed from its classroom.",
  };
}

/**
 * BATCH MEMBERSHIP, the cohort version.
 *
 * Nothing here is trusted. `requireTeacher()` re-authenticates from the cookie,
 * and the batch functions load the classroom and the actor's role from the
 * database and run `canAdministerClassroom` again for themselves. Ids that are
 * not even shaped like a uuid are dropped before they can reach SQL, and
 * reported back rather than swallowed.
 */
const batchSchema = z.object({
  classroomId: uuid,
  userIds: z.array(z.string()).max(MAX_BATCH_SIZE),
  emails: z.string().max(32_000),
});

function readBatchInput(formData: FormData) {
  const parsed = batchSchema.safeParse({
    classroomId: formData.get("classroomId"),
    userIds: formData.getAll("userId").map(String),
    emails: String(formData.get("emails") ?? ""),
  });
  if (!parsed.success) return null;

  const userIds: string[] = [];
  let malformed = 0;
  for (const value of parsed.data.userIds) {
    if (uuid.safeParse(value).success) userIds.push(value);
    else malformed += 1;
  }

  return {
    classroomId: parsed.data.classroomId,
    userIds,
    emails: parseEmailList(parsed.data.emails),
    malformed,
  };
}

function report(
  result: MembershipBatchResult,
  verb: "added" | "removed",
  malformed: number,
): ActionState {
  const summary = describeBatchResult(result, verb);
  return {
    message:
      malformed > 0
        ? `${summary} · ${malformed} invalid selections ignored`
        : summary,
  };
}

export async function addClassroomMembersAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const teacher = await requireTeacher();
  const input = readBatchInput(formData);
  if (!input) return { error: "Invalid selection." };
  if (input.userIds.length === 0 && input.emails.length === 0) {
    return { error: "Select at least one student, or paste some addresses." };
  }

  try {
    const result = await addClassroomMembersBatch(db, {
      classroomId: input.classroomId,
      actorId: teacher.id,
      userIds: input.userIds,
      emails: input.emails,
    });
    revalidateClassroom(input.classroomId);
    return report(result, "added", input.malformed);
  } catch (error) {
    if (error instanceof MembershipAuthorizationError) {
      return { error: error.message };
    }
    return { error: "Nobody could be added. Check the classroom and try again." };
  }
}

export async function removeClassroomMembersAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const teacher = await requireTeacher();
  const input = readBatchInput(formData);
  if (!input) return { error: "Invalid selection." };
  if (input.userIds.length === 0 && input.emails.length === 0) {
    return { error: "Select at least one student, or paste some addresses." };
  }

  try {
    const result = await removeClassroomMembersBatch(db, {
      classroomId: input.classroomId,
      actorId: teacher.id,
      userIds: input.userIds,
      emails: input.emails,
    });
    revalidateClassroom(input.classroomId);
    return report(result, "removed", input.malformed);
  } catch (error) {
    if (error instanceof MembershipAuthorizationError) {
      return { error: error.message };
    }
    return {
      error: "Nobody could be removed. Check the classroom and try again.",
    };
  }
}
