"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireTeacher } from "@/lib/auth/current-user";
import { createUser, type PublicUser } from "@/lib/auth/users";
import {
  canAdministerBoard,
  canDeleteBoard,
} from "@/lib/boards/authority";
import {
  MAX_BATCH_SIZE,
  MembershipAuthorizationError,
  addBoardMembersBatch,
  describeBatchResult,
  parseEmailList,
  removeBoardMembersBatch,
  type MembershipBatchResult,
} from "@/lib/boards/membership";
import {
  createBoard,
  deleteBoard,
  getBoardById,
  removeBoardMember,
  renameBoard,
  setBoardStatus,
} from "@/lib/boards/queries";
import { db } from "@/lib/db";
import { boardStatus, userRole } from "@/lib/db/schema";

export interface ActionState {
  error?: string;
  message?: string;
}

const uuid = z.string().uuid();

/**
 * Every action re-authenticates and re-authorises from the database. A server
 * action is a public HTTP endpoint: the fact that the button was only rendered
 * for teachers proves nothing.
 */
async function authorizeBoardAdmin(boardId: string): Promise<{
  teacher: PublicUser;
  board: NonNullable<Awaited<ReturnType<typeof getBoardById>>>;
}> {
  const teacher = await requireTeacher();
  const board = await getBoardById(db, boardId);
  if (!board) {
    throw new Error("The board does not exist.");
  }
  if (!canAdministerBoard({ board, user: teacher })) {
    throw new Error("You are not allowed to administer this board.");
  }
  return { teacher, board };
}

const createBoardSchema = z.object({
  title: z.string().trim().min(1, "The board title is required.").max(120),
});

export async function createBoardAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const teacher = await requireTeacher();
  const parsed = createBoardSchema.safeParse({ title: formData.get("title") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid board title." };
  }

  await createBoard(db, { title: parsed.data.title, ownerId: teacher.id });
  revalidatePath("/teacher");
  revalidatePath("/boards");
  return { message: "Board created." };
}

const setStatusSchema = z.object({
  boardId: uuid,
  status: z.enum(boardStatus.enumValues),
});

export async function setBoardStatusAction(formData: FormData): Promise<void> {
  const parsed = setStatusSchema.safeParse({
    boardId: formData.get("boardId"),
    status: formData.get("status"),
  });
  if (!parsed.success) {
    throw new Error("Invalid board status.");
  }

  await authorizeBoardAdmin(parsed.data.boardId);
  await setBoardStatus(db, parsed.data.boardId, parsed.data.status);

  revalidatePath("/teacher");
  revalidatePath(`/teacher/boards/${parsed.data.boardId}`);
  revalidatePath(`/boards/${parsed.data.boardId}`);
}

/**
 * The dashboard's one-click state change.
 *
 * It differs from `setBoardStatusAction` only in how it reports failure: the
 * dashboard reflects the new state optimistically, so a refusal has to come
 * back as a value it can revert on rather than as a thrown error that replaces
 * the whole screen. The authority itself is identical — re-authenticated,
 * re-authorised, and validated against the database enum.
 */
export async function changeBoardStatusAction(
  boardId: string,
  status: string,
): Promise<ActionState> {
  const parsed = setStatusSchema.safeParse({ boardId, status });
  if (!parsed.success) {
    return { error: "That board state does not exist." };
  }

  try {
    await authorizeBoardAdmin(parsed.data.boardId);
    await setBoardStatus(db, parsed.data.boardId, parsed.data.status);
  } catch {
    return { error: "Could not change the board state. Try again." };
  }

  revalidatePath("/teacher");
  revalidatePath(`/teacher/boards/${parsed.data.boardId}`);
  revalidatePath(`/boards/${parsed.data.boardId}`);
  return { message: "Board state changed." };
}

export async function deleteBoardAction(formData: FormData): Promise<void> {
  const parsed = z
    .object({ boardId: uuid })
    .safeParse({ boardId: formData.get("boardId") });
  if (!parsed.success) {
    throw new Error("Invalid board.");
  }

  const teacher = await requireTeacher();
  const board = await getBoardById(db, parsed.data.boardId);
  if (!board) {
    throw new Error("The board does not exist.");
  }
  // Deleting class material is restricted to the owning teacher.
  if (!canDeleteBoard({ board, user: teacher })) {
    throw new Error("Only the teacher who owns this board can delete it.");
  }

  await deleteBoard(db, parsed.data.boardId);
  revalidatePath("/teacher");
  revalidatePath("/boards");
  redirect("/teacher");
}

const renameSchema = z.object({
  boardId: uuid,
  title: z.string().trim().min(1).max(120),
});

export async function renameBoardAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = renameSchema.safeParse({
    boardId: formData.get("boardId"),
    title: formData.get("title"),
  });
  if (!parsed.success) {
    return { error: "Invalid board title." };
  }

  try {
    await authorizeBoardAdmin(parsed.data.boardId);
    await renameBoard(db, parsed.data.boardId, parsed.data.title);
  } catch {
    // Inline, like every other board action. Throwing here replaced the whole
    // page with an error screen and lost what the teacher had typed.
    return { error: "The board could not be renamed." };
  }

  revalidatePath("/teacher");
  revalidatePath(`/teacher/boards/${parsed.data.boardId}`);
  return { message: "Board renamed." };
}

const membershipSchema = z.object({ boardId: uuid, userId: uuid });

export async function removeBoardMemberAction(
  formData: FormData,
): Promise<void> {
  const parsed = membershipSchema.safeParse({
    boardId: formData.get("boardId"),
    userId: formData.get("userId"),
  });
  if (!parsed.success) {
    throw new Error("Invalid member.");
  }

  await authorizeBoardAdmin(parsed.data.boardId);
  await removeBoardMember(db, parsed.data.boardId, parsed.data.userId);
  revalidatePath(`/teacher/boards/${parsed.data.boardId}`);
  revalidatePath("/teacher");
}

/**
 * BATCH MEMBERSHIP.
 *
 * Adding twenty-five students one dropdown at a time is unusable in front of a
 * class, so these take a multi-selection and/or a pasted list of addresses.
 *
 * Nothing here is trusted. `requireTeacher()` re-authenticates from the cookie,
 * and the batch functions load the board and the actor's role from the database
 * and run `canAdministerBoard` again for themselves. Ids that are not even
 * shaped like a uuid are dropped before they can reach SQL, and reported.
 */
const batchSchema = z.object({
  boardId: uuid,
  userIds: z.array(z.string()).max(MAX_BATCH_SIZE),
  emails: z.string().max(32_000),
});

function readBatchInput(formData: FormData) {
  const parsed = batchSchema.safeParse({
    boardId: formData.get("boardId"),
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
    boardId: parsed.data.boardId,
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

export async function addBoardMembersAction(
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
    const result = await addBoardMembersBatch(db, {
      boardId: input.boardId,
      actorId: teacher.id,
      userIds: input.userIds,
      emails: input.emails,
    });
    revalidatePath(`/teacher/boards/${input.boardId}`);
    revalidatePath("/teacher");
    return report(result, "added", input.malformed);
  } catch (error) {
    if (error instanceof MembershipAuthorizationError) {
      return { error: error.message };
    }
    return { error: "Nobody could be added. Check the board and try again." };
  }
}

export async function removeBoardMembersAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const teacher = await requireTeacher();
  const input = readBatchInput(formData);
  if (!input) return { error: "Invalid selection." };
  if (input.userIds.length === 0 && input.emails.length === 0) {
    return { error: "Select at least one member, or paste some addresses." };
  }

  try {
    const result = await removeBoardMembersBatch(db, {
      boardId: input.boardId,
      actorId: teacher.id,
      userIds: input.userIds,
      emails: input.emails,
    });
    revalidatePath(`/teacher/boards/${input.boardId}`);
    revalidatePath("/teacher");
    return report(result, "removed", input.malformed);
  } catch (error) {
    if (error instanceof MembershipAuthorizationError) {
      return { error: error.message };
    }
    return { error: "Nobody could be removed. Check the board and try again." };
  }
}

const createUserSchema = z.object({
  email: z.string().trim().email().max(320),
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(200),
  role: z.enum(userRole.enumValues),
});

export async function createUserAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireTeacher();

  const parsed = createUserSchema.safeParse({
    email: formData.get("email"),
    displayName: formData.get("displayName"),
    password: formData.get("password"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ??
        "Check the email, name and password (minimum 8 characters).",
    };
  }

  try {
    await createUser(db, parsed.data);
  } catch (error) {
    const message = String(error);
    if (message.includes("users_email_unique")) {
      return { error: "That email already has an account." };
    }
    return { error: "The account could not be created." };
  }

  revalidatePath("/teacher/users");
  return { message: `Account created for ${parsed.data.email}.` };
}
