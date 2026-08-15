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
  addBoardMember,
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

export async function renameBoardAction(formData: FormData): Promise<void> {
  const parsed = renameSchema.safeParse({
    boardId: formData.get("boardId"),
    title: formData.get("title"),
  });
  if (!parsed.success) {
    throw new Error("Invalid board title.");
  }

  await authorizeBoardAdmin(parsed.data.boardId);
  await renameBoard(db, parsed.data.boardId, parsed.data.title);
  revalidatePath("/teacher");
  revalidatePath(`/teacher/boards/${parsed.data.boardId}`);
}

const membershipSchema = z.object({ boardId: uuid, userId: uuid });

export async function addBoardMemberAction(formData: FormData): Promise<void> {
  const parsed = membershipSchema.safeParse({
    boardId: formData.get("boardId"),
    userId: formData.get("userId"),
  });
  if (!parsed.success) {
    throw new Error("Invalid member.");
  }

  await authorizeBoardAdmin(parsed.data.boardId);
  await addBoardMember(db, parsed.data.boardId, parsed.data.userId);
  revalidatePath(`/teacher/boards/${parsed.data.boardId}`);
  revalidatePath("/teacher");
}

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
