import { createUser } from "@/lib/auth/users";
import {
  addBoardMember,
  createBoard,
  setBoardStatus,
} from "@/lib/boards/queries";
import type { Board, BoardStatus, UserRole } from "@/lib/db/schema";
import { testDb } from "./db";

export interface Classroom {
  teacher: { id: string; email: string; displayName: string };
  student: { id: string; email: string; displayName: string };
  outsider: { id: string; email: string; displayName: string };
  board: Board;
}

let counter = 0;

async function makeUser(role: UserRole, displayName: string) {
  counter += 1;
  return createUser(testDb, {
    email: `${role}${counter}@example.com`,
    password: "s3cret-password",
    displayName,
    role,
  });
}

/**
 * A teacher who owns a board, a student assigned to it, and a student who is
 * not - the three positions every authority test needs.
 */
export async function seedClassroom(
  status: BoardStatus = "active",
): Promise<Classroom> {
  const teacher = await makeUser("teacher", "Course Instructor");
  const student = await makeUser("student", "Ada Lovelace");
  const outsider = await makeUser("student", "Grace Hopper");

  let board = await createBoard(testDb, {
    title: "Hexagonal architecture",
    ownerId: teacher.id,
  });
  await addBoardMember(testDb, board.id, student.id);
  if (status !== "active") {
    board = await setBoardStatus(testDb, board.id, status);
  }

  return { teacher, student, outsider, board };
}
