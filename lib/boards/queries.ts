import { and, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import {
  boardMembers,
  boardStatus,
  boards,
  classroomMembers,
  classrooms,
  users,
  type Board,
  type BoardStatus,
  type UserRole,
} from "@/lib/db/schema";
import { canViewBoard, canWriteToBoard } from "./authority";

/**
 * The join that derives classroom membership for ONE user on the board being
 * selected. Written once because it is the security boundary: every query that
 * decides access has to resolve it the same way.
 *
 * When `boards.classroom_id` is null the equality is null and the join matches
 * nothing, which is exactly what an unassigned board should do.
 */
function classroomMembershipJoin(userId: string) {
  return and(
    eq(classroomMembers.classroomId, boards.classroomId),
    eq(classroomMembers.userId, userId),
  );
}

function boardMembershipJoin(userId: string) {
  return and(
    eq(boardMembers.boardId, boards.id),
    eq(boardMembers.userId, userId),
  );
}

export function isBoardStatus(value: unknown): value is BoardStatus {
  return (
    typeof value === "string" &&
    (boardStatus.enumValues as readonly string[]).includes(value)
  );
}

export interface CreateBoardInput {
  title: string;
  ownerId: string;
  /** Optional cohort. Null or absent means an unassigned board. */
  classroomId?: string | null;
}

export async function createBoard(
  db: Database,
  input: CreateBoardInput,
): Promise<Board> {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new Error("The board title is required.");
  }
  if (title.length > 120) {
    throw new Error("The board title must be 120 characters or fewer.");
  }

  const [created] = await db
    .insert(boards)
    .values({
      title,
      ownerId: input.ownerId,
      classroomId: input.classroomId ?? null,
    })
    .returning();
  if (!created) {
    throw new Error("The board could not be created.");
  }
  return created;
}

export async function getBoardById(
  db: Database,
  boardId: string,
): Promise<Board | null> {
  const [board] = await db
    .select()
    .from(boards)
    .where(eq(boards.id, boardId))
    .limit(1);
  return board ?? null;
}

export async function renameBoard(
  db: Database,
  boardId: string,
  title: string,
): Promise<Board> {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new Error("The board title is required.");
  }
  const [updated] = await db
    .update(boards)
    .set({ title: trimmed, updatedAt: new Date() })
    .where(eq(boards.id, boardId))
    .returning();
  if (!updated) {
    throw new Error("The board does not exist.");
  }
  return updated;
}

/**
 * The single writer of `boards.status`. Validates against the database enum so
 * a forged value from a form submission can never reach SQL.
 */
export async function setBoardStatus(
  db: Database,
  boardId: string,
  status: BoardStatus,
): Promise<Board> {
  if (!isBoardStatus(status)) {
    throw new Error(`Unknown board status: ${String(status)}`);
  }
  const [updated] = await db
    .update(boards)
    .set({ status, updatedAt: new Date() })
    .where(eq(boards.id, boardId))
    .returning();
  if (!updated) {
    throw new Error("The board does not exist.");
  }
  return updated;
}

export async function deleteBoard(
  db: Database,
  boardId: string,
): Promise<void> {
  await db.delete(boards).where(eq(boards.id, boardId));
}

export async function addBoardMember(
  db: Database,
  boardId: string,
  userId: string,
): Promise<void> {
  await db
    .insert(boardMembers)
    .values({ boardId, userId })
    .onConflictDoNothing();
}

/**
 * Adds several members in one statement. Returns the ids that were actually
 * inserted: Postgres reports nothing for a row that hit the conflict, so the
 * caller learns who was already a member without a second read-then-write that
 * two teachers could interleave.
 */
export async function addBoardMembers(
  db: Database,
  boardId: string,
  userIds: readonly string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const inserted = await db
    .insert(boardMembers)
    .values(userIds.map((userId) => ({ boardId, userId })))
    .onConflictDoNothing()
    .returning({ userId: boardMembers.userId });
  return inserted.map((row) => row.userId);
}

/** Removes several members in one statement, returning who was really removed. */
export async function removeBoardMembers(
  db: Database,
  boardId: string,
  userIds: readonly string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const deleted = await db
    .delete(boardMembers)
    .where(
      and(
        eq(boardMembers.boardId, boardId),
        inArray(boardMembers.userId, [...userIds]),
      ),
    )
    .returning({ userId: boardMembers.userId });
  return deleted.map((row) => row.userId);
}

export async function removeBoardMember(
  db: Database,
  boardId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(boardMembers)
    .where(
      and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)),
    );
}

export interface BoardMemberRow {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  joinedAt: Date;
}

export async function listBoardMembers(
  db: Database,
  boardId: string,
): Promise<BoardMemberRow[]> {
  return db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      joinedAt: boardMembers.joinedAt,
    })
    .from(boardMembers)
    .innerJoin(users, eq(boardMembers.userId, users.id))
    .where(eq(boardMembers.boardId, boardId))
    .orderBy(users.displayName);
}

export interface BoardRosterRow {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  /** True when the row comes from `board_members` rather than the classroom. */
  isExplicitMember: boolean;
}

/**
 * EVERYONE who can reach this board: the classroom roster plus the explicit
 * members, as one deduplicated list. This is what the board's people panel must
 * show — listing only `board_members` on a classroom board would tell a class
 * of twenty-five that nobody is assigned.
 *
 * Two indexed reads merged in memory rather than one clever UNION: a cohort is
 * twenty-five people, and a reader can see at a glance which list won.
 */
export async function listBoardRoster(
  db: Database,
  boardId: string,
): Promise<BoardRosterRow[]> {
  const [explicit, viaClassroom] = await Promise.all([
    listBoardMembers(db, boardId),
    listClassroomMembersForBoard(db, boardId),
  ]);

  const roster = new Map<string, BoardRosterRow>();
  for (const person of viaClassroom) {
    roster.set(person.id, { ...person, isExplicitMember: false });
  }
  // Explicit wins the flag: it is the membership a teacher can remove here.
  for (const person of explicit) {
    roster.set(person.id, {
      id: person.id,
      email: person.email,
      displayName: person.displayName,
      role: person.role,
      isExplicitMember: true,
    });
  }

  return [...roster.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
}

/** The classroom roster of a board, empty when the board has no classroom. */
async function listClassroomMembersForBoard(
  db: Database,
  boardId: string,
): Promise<
  { id: string; email: string; displayName: string; role: UserRole }[]
> {
  return db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
    })
    .from(boards)
    .innerJoin(
      classroomMembers,
      eq(classroomMembers.classroomId, boards.classroomId),
    )
    .innerJoin(users, eq(users.id, classroomMembers.userId))
    .where(eq(boards.id, boardId))
    .orderBy(users.displayName);
}

export interface BoardListRow extends Board {
  memberCount: number;
  ownerName: string;
  classroomName: string | null;
}

/**
 * "How many people can reach this board", the number a teacher actually wants:
 * the classroom roster UNION the explicit members, deduplicated by the UNION
 * itself. A student who is in the classroom AND listed explicitly is one
 * person, not two. When `classroom_id` is null the second branch is empty and
 * the count is the explicit membership, exactly as before classrooms existed.
 */
const boardReachCount = sql<number>`(
  select count(*) from (
    select ${boardMembers.userId} from ${boardMembers}
      where ${boardMembers.boardId} = ${boards.id}
    union
    select ${classroomMembers.userId} from ${classroomMembers}
      where ${classroomMembers.classroomId} = ${boards.classroomId}
  ) as reach
)`;

/** Teacher panel listing: every board, its cohort and how many people reach it. */
export async function listBoardsForTeacher(
  db: Database,
): Promise<BoardListRow[]> {
  const rows = await db
    .select({
      id: boards.id,
      title: boards.title,
      ownerId: boards.ownerId,
      classroomId: boards.classroomId,
      status: boards.status,
      createdAt: boards.createdAt,
      updatedAt: boards.updatedAt,
      ownerName: users.displayName,
      classroomName: classrooms.name,
      memberCount: boardReachCount,
    })
    .from(boards)
    .innerJoin(users, eq(boards.ownerId, users.id))
    .leftJoin(classrooms, eq(classrooms.id, boards.classroomId))
    .orderBy(desc(boards.createdAt));

  return rows.map((row) => ({ ...row, memberCount: Number(row.memberCount) }));
}

export interface UserBoardRow extends Board {
  classroomName: string | null;
}

/**
 * "My boards": what this user may open. Boards reached through the classroom,
 * boards they were listed on explicitly, and — for a teacher — the boards they
 * own. The three are a union, so a student in the classroom of a board they are
 * also an explicit member of still sees it once (`selectDistinct`).
 */
export async function listBoardsForUser(
  db: Database,
  userId: string,
): Promise<UserBoardRow[]> {
  return db
    .selectDistinct({
      id: boards.id,
      title: boards.title,
      ownerId: boards.ownerId,
      classroomId: boards.classroomId,
      status: boards.status,
      createdAt: boards.createdAt,
      updatedAt: boards.updatedAt,
      classroomName: classrooms.name,
    })
    .from(boards)
    .leftJoin(boardMembers, boardMembershipJoin(userId))
    .leftJoin(classroomMembers, classroomMembershipJoin(userId))
    .leftJoin(classrooms, eq(classrooms.id, boards.classroomId))
    .where(
      or(
        eq(boards.ownerId, userId),
        eq(boardMembers.userId, userId),
        eq(classroomMembers.userId, userId),
      ),
    )
    .orderBy(desc(boards.updatedAt));
}

/** Every board assigned to a classroom, for the cohort's admin page. */
export async function listBoardsInClassroom(
  db: Database,
  classroomId: string,
): Promise<Board[]> {
  return db
    .select()
    .from(boards)
    .where(eq(boards.classroomId, classroomId))
    .orderBy(desc(boards.updatedAt));
}

/**
 * Assigns a board to a classroom, or clears the assignment with null. This is
 * an ACCESS DECISION: it grants the whole cohort at once and revokes the
 * previous one at once, because access is a join and never a copy.
 */
export async function setBoardClassroom(
  db: Database,
  boardId: string,
  classroomId: string | null,
): Promise<Board> {
  const [updated] = await db
    .update(boards)
    .set({ classroomId, updatedAt: new Date() })
    .where(eq(boards.id, boardId))
    .returning();
  if (!updated) {
    throw new Error("The board does not exist.");
  }
  return updated;
}

export interface BoardAccess {
  board: Board;
  /** An explicit `board_members` row: the additive exception. */
  isMember: boolean;
  /** Reached through the board's classroom: the normal path. */
  isClassroomMember: boolean;
  canView: boolean;
  canWrite: boolean;
  role: UserRole;
}

/**
 * AUTHORITATIVE ACCESS CHECK. One round trip: board row + BOTH membership paths
 * + the user's role straight from the database, then the pure rules in
 * `authority.ts`.
 *
 * The classroom membership is resolved by a join on `boards.classroom_id`, not
 * by a copy made when the board was assigned: adding a student to the classroom
 * grants this board on the very next call, and removing them revokes it on the
 * very next call. There is no cached verdict anywhere on this path.
 *
 * The websocket server calls this on every handshake AND on every update frame
 * instead of trusting anything the client says. Returns null when the board
 * does not exist — the caller must render the same answer for null and for
 * `canView === false`, so membership cannot be probed from outside.
 */
export async function getBoardAccess(
  db: Database,
  boardId: string,
  userId: string,
): Promise<BoardAccess | null> {
  const [row] = await db
    .select({
      board: boards,
      role: users.role,
      memberUserId: boardMembers.userId,
      classroomMemberUserId: classroomMembers.userId,
    })
    .from(boards)
    .innerJoin(users, eq(users.id, userId))
    .leftJoin(boardMembers, boardMembershipJoin(userId))
    .leftJoin(classroomMembers, classroomMembershipJoin(userId))
    .where(eq(boards.id, boardId))
    .limit(1);

  if (!row) return null;

  const input = {
    board: row.board,
    user: { id: userId, role: row.role },
    isMember: row.memberUserId !== null,
    isClassroomMember: row.classroomMemberUserId !== null,
  };

  return {
    board: row.board,
    isMember: input.isMember,
    isClassroomMember: input.isClassroomMember,
    canView: canViewBoard(input),
    canWrite: canWriteToBoard(input),
    role: row.role,
  };
}

/**
 * Statuses of several boards in ONE indexed query. This is what the
 * collaboration server polls for its open rooms: the cost is a single query per
 * interval for the whole process, independent of how many students are
 * connected. Boards that no longer exist are simply absent from the map.
 */
export async function getBoardStatuses(
  db: Database,
  boardIds: readonly string[],
): Promise<Map<string, BoardStatus>> {
  if (boardIds.length === 0) return new Map();
  const rows = await db
    .select({ id: boards.id, status: boards.status })
    .from(boards)
    .where(inArray(boards.id, [...boardIds]));
  return new Map(rows.map((row) => [row.id, row.status]));
}

/** Touches `updated_at`, e.g. after Phase B persists a snapshot. */
export async function touchBoard(
  db: Database,
  boardId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(boards)
    .set({ updatedAt: now })
    .where(eq(boards.id, boardId));
}

/** Count of boards, used by the teacher dashboard header. */
export async function countBoards(db: Database): Promise<number> {
  const [row] = await db.select({ value: count() }).from(boards);
  return Number(row?.value ?? 0);
}

export const boardStatusValues = boardStatus.enumValues;
export type { BoardStatus };
