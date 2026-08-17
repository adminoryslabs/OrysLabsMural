import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import {
  boards,
  classroomMembers,
  classrooms,
  users,
  type Classroom,
  type UserRole,
} from "@/lib/db/schema";

export const MAX_CLASSROOM_NAME_LENGTH = 120;

/** Postgres's unique-violation code, for turning a race into a readable error. */
const UNIQUE_VIOLATION = "23505";

export class DuplicateClassroomNameError extends Error {
  constructor(name: string) {
    super(`There is already a classroom called "${name}".`);
    this.name = "DuplicateClassroomNameError";
  }
}

function normalizeName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new Error("The classroom name is required.");
  }
  if (name.length > MAX_CLASSROOM_NAME_LENGTH) {
    throw new Error(
      `The classroom name must be ${MAX_CLASSROOM_NAME_LENGTH} characters or fewer.`,
    );
  }
  return name;
}

/**
 * Drizzle wraps the driver's error, so the SQLSTATE lives on the cause rather
 * than on what is thrown. Walking the chain is what makes this a readable
 * message instead of "Failed query: insert into…" in front of a class.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current != null; ) {
    if (
      typeof current === "object" &&
      "code" in current &&
      (current as { code?: unknown }).code === UNIQUE_VIOLATION
    ) {
      return true;
    }
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return false;
}

export interface CreateClassroomInput {
  name: string;
  ownerId: string;
}

export async function createClassroom(
  db: Database,
  input: CreateClassroomInput,
): Promise<Classroom> {
  const name = normalizeName(input.name);
  try {
    const [created] = await db
      .insert(classrooms)
      .values({ name, ownerId: input.ownerId })
      .returning();
    if (!created) {
      throw new Error("The classroom could not be created.");
    }
    return created;
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateClassroomNameError(name);
    throw error;
  }
}

export async function getClassroomById(
  db: Database,
  classroomId: string,
): Promise<Classroom | null> {
  const [classroom] = await db
    .select()
    .from(classrooms)
    .where(eq(classrooms.id, classroomId))
    .limit(1);
  return classroom ?? null;
}

export async function renameClassroom(
  db: Database,
  classroomId: string,
  name: string,
): Promise<Classroom> {
  const trimmed = normalizeName(name);
  try {
    const [updated] = await db
      .update(classrooms)
      .set({ name: trimmed, updatedAt: new Date() })
      .where(eq(classrooms.id, classroomId))
      .returning();
    if (!updated) {
      throw new Error("The classroom does not exist.");
    }
    return updated;
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateClassroomNameError(trimmed);
    throw error;
  }
}

/**
 * Deletes a cohort. `classroom_members` cascades away with it; the BOARDS DO
 * NOT — `boards.classroom_id` is `on delete set null`, so every board survives
 * as an unassigned board falling back to its explicit `board_members`.
 *
 * That is the conservative direction on both axes at once: no class material is
 * destroyed, and no access is silently widened. It does mean the cohort loses
 * those boards immediately, which is the same revocation as removing them from
 * the classroom one by one — so the UI says how many boards it will detach
 * before it asks.
 */
export async function deleteClassroom(
  db: Database,
  classroomId: string,
): Promise<void> {
  await db.delete(classrooms).where(eq(classrooms.id, classroomId));
}

export interface ClassroomListRow extends Classroom {
  ownerName: string;
  memberCount: number;
  boardCount: number;
}

export async function listClassrooms(
  db: Database,
): Promise<ClassroomListRow[]> {
  const rows = await db
    .select({
      id: classrooms.id,
      name: classrooms.name,
      ownerId: classrooms.ownerId,
      createdAt: classrooms.createdAt,
      updatedAt: classrooms.updatedAt,
      ownerName: users.displayName,
      memberCount: sql<number>`(
        select count(*) from ${classroomMembers}
         where ${classroomMembers.classroomId} = ${classrooms.id}
      )`,
      boardCount: sql<number>`(
        select count(*) from ${boards}
         where ${boards.classroomId} = ${classrooms.id}
      )`,
    })
    .from(classrooms)
    .innerJoin(users, eq(users.id, classrooms.ownerId))
    .orderBy(asc(classrooms.name));

  return rows.map((row) => ({
    ...row,
    memberCount: Number(row.memberCount),
    boardCount: Number(row.boardCount),
  }));
}

export interface ClassroomMemberRow {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  joinedAt: Date;
}

export async function listClassroomMembers(
  db: Database,
  classroomId: string,
): Promise<ClassroomMemberRow[]> {
  return db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      joinedAt: classroomMembers.joinedAt,
    })
    .from(classroomMembers)
    .innerJoin(users, eq(classroomMembers.userId, users.id))
    .where(eq(classroomMembers.classroomId, classroomId))
    .orderBy(users.displayName);
}

/**
 * Adds several students in one statement, returning who was really inserted:
 * Postgres reports nothing for a row that hit the conflict, so "who was already
 * in this classroom" is answered by the database rather than by a
 * read-then-write two teachers could interleave.
 */
export async function addClassroomMembers(
  db: Database,
  classroomId: string,
  userIds: readonly string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const inserted = await db
    .insert(classroomMembers)
    .values(userIds.map((userId) => ({ classroomId, userId })))
    .onConflictDoNothing()
    .returning({ userId: classroomMembers.userId });
  return inserted.map((row) => row.userId);
}

/** Removes several students in one statement, returning who was really removed. */
export async function removeClassroomMembers(
  db: Database,
  classroomId: string,
  userIds: readonly string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const deleted = await db
    .delete(classroomMembers)
    .where(
      and(
        eq(classroomMembers.classroomId, classroomId),
        inArray(classroomMembers.userId, [...userIds]),
      ),
    )
    .returning({ userId: classroomMembers.userId });
  return deleted.map((row) => row.userId);
}

/** Count of classrooms, for the panel header. */
export async function countClassrooms(db: Database): Promise<number> {
  const [row] = await db.select({ value: count() }).from(classrooms);
  return Number(row?.value ?? 0);
}
