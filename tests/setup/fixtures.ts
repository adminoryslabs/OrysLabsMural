import { randomUUID } from "node:crypto";
import { createUser } from "@/lib/auth/users";
import {
  addBoardMember,
  createBoard,
  setBoardStatus,
} from "@/lib/boards/queries";
import {
  addClassroomMembers,
  createClassroom,
} from "@/lib/classrooms/queries";
import type {
  Board,
  BoardStatus,
  Classroom,
  UserRole,
} from "@/lib/db/schema";
import { testDb } from "./db";

export interface BoardFixture {
  teacher: { id: string; email: string; displayName: string };
  student: { id: string; email: string; displayName: string };
  outsider: { id: string; email: string; displayName: string };
  board: Board;
}

/**
 * Unique across processes, not just within one.
 *
 * A module-level counter is per worker, and vitest runs test files in parallel
 * workers that all share one database — so two workers minted the same
 * `teacher1@example.com` and the same `Cohort 1` and collided on the unique
 * indexes. It surfaced far from the cause: a room's snapshot flush swallows its
 * error, so the failure read as "the snapshot never arrived".
 */
function uniqueSuffix(): string {
  return randomUUID().slice(0, 8);
}

async function makeUser(role: UserRole, displayName: string) {
  return createUser(testDb, {
    email: `${role}-${uniqueSuffix()}@example.com`,
    password: "s3cret-password",
    displayName,
    role,
  });
}

/**
 * A teacher who owns a board, a student listed in `board_members`, and a
 * student who is not - the three positions every authority test needs. The
 * board has NO classroom, so this fixture is also the proof that an unassigned
 * board behaves exactly as it did before classrooms existed.
 */
export async function seedBoardWithMember(
  status: BoardStatus = "active",
): Promise<BoardFixture> {
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

export interface CohortFixture {
  teacher: { id: string; email: string; displayName: string };
  /** In the classroom, and in nothing else. The normal student. */
  cohortStudent: { id: string; email: string; displayName: string };
  /** In `board_members` only, NOT in the classroom. The escape hatch. */
  guest: { id: string; email: string; displayName: string };
  /** In neither. Must be indistinguishable from a missing board. */
  outsider: { id: string; email: string; displayName: string };
  classroom: Classroom;
  board: Board;
  /** Same classroom, second board: revocation must hit both at once. */
  secondBoard: Board;
}

/**
 * A cohort with two boards, one student who reaches them through the classroom,
 * one guest who reaches only the first board through `board_members`, and one
 * outsider who reaches nothing. Every position the access model has.
 */
export async function seedCohort(
  status: BoardStatus = "active",
): Promise<CohortFixture> {
  const teacher = await makeUser("teacher", "Course Instructor");
  const cohortStudent = await makeUser("student", "Ada Lovelace");
  const guest = await makeUser("student", "Alan Turing");
  const outsider = await makeUser("student", "Grace Hopper");

  const classroom = await createClassroom(testDb, {
    // Classroom names carry a unique index, so this must not repeat across
    // parallel workers either.
    name: `Cohort ${uniqueSuffix()}`,
    ownerId: teacher.id,
  });
  await addClassroomMembers(testDb, classroom.id, [cohortStudent.id]);

  let board = await createBoard(testDb, {
    title: "Requirements engineering",
    ownerId: teacher.id,
    classroomId: classroom.id,
  });
  const secondBoard = await createBoard(testDb, {
    title: "Hexagonal architecture",
    ownerId: teacher.id,
    classroomId: classroom.id,
  });
  // The additive exception: on the first board only, and never in the cohort.
  await addBoardMember(testDb, board.id, guest.id);

  if (status !== "active") {
    board = await setBoardStatus(testDb, board.id, status);
  }

  return {
    teacher,
    cohortStudent,
    guest,
    outsider,
    classroom,
    board,
    secondBoard,
  };
}
