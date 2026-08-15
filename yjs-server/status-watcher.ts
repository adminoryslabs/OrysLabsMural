import type { Database } from "@/lib/db";
import { getBoardStatuses } from "@/lib/boards/queries";
import type { BoardStatus } from "@/lib/db/schema";
import type { Logger } from "./logger";

export interface BoardStatusWatcherOptions {
  db: Database;
  /** How often the open boards are re-read. 0 disables the watcher. */
  intervalMs: number;
  /** The boards that currently have at least one connection. */
  openBoardIds(): string[];
  /** A board's status changed, or the board vanished (`null`). */
  onChanged(boardId: string, status: BoardStatus | null): void;
  logger: Logger;
}

export interface BoardStatusWatcher {
  /**
   * Records the status a handshake just read, so the first poll compares
   * against it instead of treating it as a first sighting. Without this, a
   * status changed between a client connecting and the first poll completing
   * would be silently adopted as the baseline and never announced.
   */
  seed(boardId: string, status: BoardStatus): void;
  /** Runs one pass immediately. Exposed for deterministic tests. */
  poll(): Promise<void>;
  stop(): void;
}

/**
 * WHY THIS EXISTS: the per-write-frame authority check can only answer a client
 * that is still talking. A client that has been frozen out stops sending write
 * frames, so an unfreeze would never reach it - it would stay read-only until
 * the page was reloaded, which is exactly the defect this watcher removes.
 *
 * WHY POLLING RATHER THAN LISTEN/NOTIFY: this costs one indexed query per
 * interval for ALL open boards at once - not one per board and certainly not
 * one per connected client - and it has no failure mode that needs recovering
 * from. A missed NOTIFY (dropped listener connection, a status written by psql
 * or a migration rather than by the app) leaves a classroom silently stuck;
 * a poll cannot miss anything, because it asks the database what is true rather
 * than waiting to be told. Nothing a client does, including saying nothing at
 * all, can defeat it.
 */
export function startBoardStatusWatcher(
  options: BoardStatusWatcherOptions,
): BoardStatusWatcher {
  const { db, intervalMs, openBoardIds, onChanged, logger } = options;
  // `null` records a board that has been deleted, so it is reported once.
  const known = new Map<string, BoardStatus | null>();
  let running = false;
  let stopped = false;

  async function poll(): Promise<void> {
    // One pass at a time: a slow database must not queue passes up.
    if (running || stopped) return;
    running = true;
    try {
      const boardIds = openBoardIds();
      for (const boardId of [...known.keys()]) {
        if (!boardIds.includes(boardId)) known.delete(boardId);
      }
      if (boardIds.length === 0) return;

      const statuses = await getBoardStatuses(db, boardIds);
      for (const boardId of boardIds) {
        const current = statuses.get(boardId) ?? null;
        const previous = known.has(boardId) ? known.get(boardId) : undefined;
        known.set(boardId, current);

        if (previous === undefined) {
          // The first sighting of a board is not a change: the handshake
          // already told every connection on it where things stood. A board
          // that is already gone is the one exception worth reporting.
          if (current === null) onChanged(boardId, null);
          continue;
        }
        if (previous !== current) onChanged(boardId, current);
      }
    } catch (error) {
      logger.error("board status poll failed", error);
    } finally {
      running = false;
    }
  }

  let timer: NodeJS.Timeout | null = null;
  if (intervalMs > 0) {
    timer = setInterval(() => void poll(), intervalMs);
    timer.unref?.();
  }

  return {
    seed(boardId, status) {
      // Never overwrite a polled value: the poll is always the fresher read.
      if (!known.has(boardId)) known.set(boardId, status);
    },
    poll,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
