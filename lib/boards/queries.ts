import { and, count, desc, eq, inArray, or } from "drizzle-orm";
import type { Database } from "@/lib/db";
import {
  boardMembers,
  boardStatus,
  boards,
  users,
  type Board,
  type BoardStatus,
  type UserRole,
} from "@/lib/db/schema";
import { canViewBoard, canWriteToBoard } from "./authority";

export function isBoardStatus(value: unknown): value is BoardStatus {
  return (
    typeof value === "string" &&
    (boardStatus.enumValues as readonly string[]).includes(value)
  );
}

export interface CreateBoardInput {
  title: string;
  ownerId: string;
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
    .values({ title, ownerId: input.ownerId })
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

export interface BoardListRow extends Board {
  memberCount: number;
  ownerName: string;
}

/** Teacher panel listing: every board plus its member count. */
export async function listBoardsForTeacher(
  db: Database,
): Promise<BoardListRow[]> {
  const rows = await db
    .select({
      id: boards.id,
      title: boards.title,
      ownerId: boards.ownerId,
      status: boards.status,
      createdAt: boards.createdAt,
      updatedAt: boards.updatedAt,
      ownerName: users.displayName,
      memberCount: count(boardMembers.userId),
    })
    .from(boards)
    .innerJoin(users, eq(boards.ownerId, users.id))
    .leftJoin(boardMembers, eq(boardMembers.boardId, boards.id))
    .groupBy(boards.id, users.displayName)
    .orderBy(desc(boards.createdAt));

  return rows.map((row) => ({ ...row, memberCount: Number(row.memberCount) }));
}

/** "My boards": what this user may open. Teachers also see boards they own. */
export async function listBoardsForUser(
  db: Database,
  userId: string,
): Promise<Board[]> {
  return db
    .selectDistinct({
      id: boards.id,
      title: boards.title,
      ownerId: boards.ownerId,
      status: boards.status,
      createdAt: boards.createdAt,
      updatedAt: boards.updatedAt,
    })
    .from(boards)
    .leftJoin(
      boardMembers,
      and(
        eq(boardMembers.boardId, boards.id),
        eq(boardMembers.userId, userId),
      ),
    )
    .where(or(eq(boards.ownerId, userId), eq(boardMembers.userId, userId)))
    .orderBy(desc(boards.updatedAt));
}

export interface BoardAccess {
  board: Board;
  isMember: boolean;
  canView: boolean;
  canWrite: boolean;
  role: UserRole;
}

/**
 * AUTHORITATIVE ACCESS CHECK. One round trip: board row + membership + the
 * user's role straight from the database, then the pure rules in `authority.ts`.
 *
 * Phase B's websocket server must call this on every handshake (and after a
 * status change broadcast) instead of trusting anything the client says.
 * Returns null when the board does not exist.
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
    })
    .from(boards)
    .innerJoin(users, eq(users.id, userId))
    .leftJoin(
      boardMembers,
      and(
        eq(boardMembers.boardId, boards.id),
        eq(boardMembers.userId, userId),
      ),
    )
    .where(eq(boards.id, boardId))
    .limit(1);

  if (!row) return null;

  const input = {
    board: row.board,
    user: { id: userId, role: row.role },
    isMember: row.memberUserId !== null,
  };

  return {
    board: row.board,
    isMember: input.isMember,
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
