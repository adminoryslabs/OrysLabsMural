import { and, desc, eq, notInArray } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { boardSnapshots } from "@/lib/db/schema";

/**
 * PHASE B SEAM — Yjs persistence.
 *
 * The websocket server calls `saveBoardSnapshot(db, boardId,
 * Y.encodeStateAsUpdate(doc))` on a debounce and on the last disconnect, and
 * `getLatestBoardSnapshot` when the first client opens a board. The table is
 * append-only; `pruneBoardSnapshots` trims history.
 */

export interface BoardSnapshotRow {
  id: string;
  boardId: string;
  state: Uint8Array;
  createdAt: Date;
}

export async function saveBoardSnapshot(
  db: Database,
  boardId: string,
  state: Uint8Array,
  options: { now?: Date } = {},
): Promise<string> {
  const values = {
    boardId,
    yjsState: Buffer.from(state),
    ...(options.now ? { createdAt: options.now } : {}),
  };
  const [row] = await db
    .insert(boardSnapshots)
    .values(values)
    .returning({ id: boardSnapshots.id });
  if (!row) {
    throw new Error("The snapshot could not be stored.");
  }
  return row.id;
}

export async function getLatestBoardSnapshot(
  db: Database,
  boardId: string,
): Promise<BoardSnapshotRow | null> {
  const [row] = await db
    .select()
    .from(boardSnapshots)
    .where(eq(boardSnapshots.boardId, boardId))
    .orderBy(desc(boardSnapshots.createdAt), desc(boardSnapshots.id))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    boardId: row.boardId,
    state: new Uint8Array(row.yjsState),
    createdAt: row.createdAt,
  };
}

/** Keeps the newest `keep` snapshots of a board. Returns how many were removed. */
export async function pruneBoardSnapshots(
  db: Database,
  boardId: string,
  keep: number,
): Promise<number> {
  if (keep < 1) {
    throw new Error("At least one snapshot must be kept.");
  }
  const survivors = await db
    .select({ id: boardSnapshots.id })
    .from(boardSnapshots)
    .where(eq(boardSnapshots.boardId, boardId))
    .orderBy(desc(boardSnapshots.createdAt), desc(boardSnapshots.id))
    .limit(keep);

  const keepIds = survivors.map((row) => row.id);
  if (keepIds.length === 0) return 0;

  const removed = await db
    .delete(boardSnapshots)
    .where(
      and(
        eq(boardSnapshots.boardId, boardId),
        notInArray(boardSnapshots.id, keepIds),
      ),
    )
    .returning({ id: boardSnapshots.id });

  return removed.length;
}
