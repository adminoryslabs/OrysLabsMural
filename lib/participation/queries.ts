import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import {
  boardSessions,
  boards,
  users,
  type BoardSession,
} from "@/lib/db/schema";

/**
 * PHASE B SEAM — participation / attribution log.
 *
 * Lifecycle of one websocket connection:
 *   1. handshake accepted  -> startBoardSession(...)      (returns a row id)
 *   2. every N seconds     -> recordBoardActivity(id, { edits })
 *   3. socket closed       -> endBoardSession(id)
 *   4. periodic job        -> closeStaleBoardSessions(...) for connections that
 *                             died without a clean close
 *
 * Everything the instructor needs later ("which boards did student X take part
 * in, and how much") is derived from these rows; no schema change required.
 */

/**
 * Effective end of a session: its clean disconnect if there is one, otherwise
 * the last heartbeat. Never "now", so an abandoned tab cannot inflate the
 * numbers forever.
 */
const sessionEnd = sql<Date>`coalesce(${boardSessions.disconnectedAt}, ${boardSessions.lastSeenAt})`;

const totalSecondsExpression = sql<number>`
  coalesce(
    sum(
      extract(epoch from (
        coalesce(${boardSessions.disconnectedAt}, ${boardSessions.lastSeenAt})
        - ${boardSessions.connectedAt}
      ))
    ),
    0
  )::bigint
`;

export interface StartBoardSessionInput {
  boardId: string;
  userId: string;
  connectionId?: string;
  now?: Date;
}

export async function startBoardSession(
  db: Database,
  input: StartBoardSessionInput,
): Promise<BoardSession> {
  const now = input.now ?? new Date();
  const [session] = await db
    .insert(boardSessions)
    .values({
      boardId: input.boardId,
      userId: input.userId,
      connectionId: input.connectionId ?? null,
      connectedAt: now,
      lastSeenAt: now,
    })
    .returning();

  if (!session) {
    throw new Error("The board session could not be opened.");
  }
  return session;
}

/**
 * Heartbeat plus edit accounting. Returns null when the session id is unknown,
 * because a late heartbeat from a closed connection must not crash the server.
 */
export async function recordBoardActivity(
  db: Database,
  sessionId: string,
  options: { edits?: number; now?: Date } = {},
): Promise<BoardSession | null> {
  const now = options.now ?? new Date();
  const edits = Math.max(0, Math.trunc(options.edits ?? 0));

  const [updated] = await db
    .update(boardSessions)
    .set({
      lastSeenAt: now,
      editCount: sql`${boardSessions.editCount} + ${edits}`,
    })
    .where(eq(boardSessions.id, sessionId))
    .returning();

  return updated ?? null;
}

/** Closes a session. Idempotent: an already closed session keeps its end time. */
export async function endBoardSession(
  db: Database,
  sessionId: string,
  options: { edits?: number; now?: Date } = {},
): Promise<BoardSession | null> {
  const now = options.now ?? new Date();
  const edits = Math.max(0, Math.trunc(options.edits ?? 0));

  const [updated] = await db
    .update(boardSessions)
    .set({
      // The timestamp is bound as an ISO string and cast in SQL: postgres.js
      // cannot infer the type of a bare Date inside a raw fragment.
      disconnectedAt: sql`coalesce(${boardSessions.disconnectedAt}, ${now.toISOString()}::timestamptz)`,
      lastSeenAt: sql`greatest(${boardSessions.lastSeenAt}, ${now.toISOString()}::timestamptz)`,
      editCount: sql`${boardSessions.editCount} + ${edits}`,
    })
    .where(eq(boardSessions.id, sessionId))
    .returning();

  return updated ?? null;
}

/**
 * Closes connections whose heartbeat went silent, dating the disconnect at the
 * last heartbeat rather than now. Run it from a cron/interval in Phase B.
 */
export async function closeStaleBoardSessions(
  db: Database,
  options: { staleAfterSeconds?: number; now?: Date } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const staleAfterSeconds = options.staleAfterSeconds ?? 120;
  const cutoff = new Date(now.getTime() - staleAfterSeconds * 1000);

  const closed = await db
    .update(boardSessions)
    .set({ disconnectedAt: sql`${boardSessions.lastSeenAt}` })
    .where(
      and(
        isNull(boardSessions.disconnectedAt),
        lt(boardSessions.lastSeenAt, cutoff),
      ),
    )
    .returning({ id: boardSessions.id });

  return closed.length;
}

export interface ParticipationRow {
  boardId: string;
  boardTitle: string;
  userId: string;
  displayName: string;
  email: string;
  sessionCount: number;
  openSessionCount: number;
  totalSeconds: number;
  totalEdits: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

const participationSelection = {
  boardId: boardSessions.boardId,
  boardTitle: boards.title,
  userId: boardSessions.userId,
  displayName: users.displayName,
  email: users.email,
  sessionCount: sql<number>`count(*)::int`,
  openSessionCount: sql<number>`count(*) filter (where ${boardSessions.disconnectedAt} is null)::int`,
  totalSeconds: totalSecondsExpression,
  firstSeenAt: sql<Date>`min(${boardSessions.connectedAt})`,
  lastSeenAt: sql<Date>`max(${sessionEnd})`,
  totalEdits: sql<number>`coalesce(sum(${boardSessions.editCount}), 0)::int`,
} as const;

function normalizeRow(row: {
  boardId: string;
  boardTitle: string;
  userId: string;
  displayName: string;
  email: string;
  sessionCount: number | string;
  openSessionCount: number | string;
  totalSeconds: number | string;
  totalEdits: number | string;
  firstSeenAt: Date | string;
  lastSeenAt: Date | string;
}): ParticipationRow {
  return {
    boardId: row.boardId,
    boardTitle: row.boardTitle,
    userId: row.userId,
    displayName: row.displayName,
    email: row.email,
    sessionCount: Number(row.sessionCount),
    openSessionCount: Number(row.openSessionCount),
    totalSeconds: Number(row.totalSeconds),
    totalEdits: Number(row.totalEdits),
    firstSeenAt: new Date(row.firstSeenAt),
    lastSeenAt: new Date(row.lastSeenAt),
  };
}

/** "Which boards did this user take part in, and how much." */
export async function getUserParticipation(
  db: Database,
  userId: string,
): Promise<ParticipationRow[]> {
  const rows = await db
    .select(participationSelection)
    .from(boardSessions)
    .innerJoin(boards, eq(boards.id, boardSessions.boardId))
    .innerJoin(users, eq(users.id, boardSessions.userId))
    .where(eq(boardSessions.userId, userId))
    .groupBy(
      boardSessions.boardId,
      boards.title,
      boardSessions.userId,
      users.displayName,
      users.email,
    )
    .orderBy(boards.title);

  return rows.map(normalizeRow);
}

/** "Who took part in this board, and how much." */
export async function getBoardParticipation(
  db: Database,
  boardId: string,
): Promise<ParticipationRow[]> {
  const rows = await db
    .select(participationSelection)
    .from(boardSessions)
    .innerJoin(boards, eq(boards.id, boardSessions.boardId))
    .innerJoin(users, eq(users.id, boardSessions.userId))
    .where(eq(boardSessions.boardId, boardId))
    .groupBy(
      boardSessions.boardId,
      boards.title,
      boardSessions.userId,
      users.displayName,
      users.email,
    )
    .orderBy(users.displayName);

  return rows.map(normalizeRow);
}

/** Raw session rows for a board, newest first. Useful for a timeline view. */
export async function listBoardSessions(
  db: Database,
  boardId: string,
  limit = 200,
): Promise<BoardSession[]> {
  return db
    .select()
    .from(boardSessions)
    .where(eq(boardSessions.boardId, boardId))
    .orderBy(sql`${boardSessions.connectedAt} desc`)
    .limit(limit);
}
