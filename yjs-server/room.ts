import { Awareness, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import type { Database } from "@/lib/db";
import { touchBoard } from "@/lib/boards/queries";
import {
  getLatestBoardSnapshot,
  pruneBoardSnapshots,
  saveBoardSnapshot,
} from "@/lib/boards/snapshots";
import { encodeAwareness, encodeUpdate } from "./protocol";
import type { Logger } from "./logger";

/** Origin tag for updates applied while loading the stored snapshot. */
const HYDRATION_ORIGIN = Symbol("hydration");

/** What the room needs from a connection. Keeps room.ts free of socket code. */
export interface RoomMember {
  send(message: Uint8Array): void;
  /** Awareness client ids this connection owns, cleared when it drops. */
  readonly awarenessClientIds: Set<number>;
}

export interface BoardRoomOptions {
  db: Database;
  boardId: string;
  snapshotDebounceMs: number;
  snapshotHistoryLimit: number;
  logger: Logger;
}

/**
 * One live board: the shared Yjs document, the presence state, and the
 * debounced persistence that makes the board survive a server restart.
 *
 * The room knows nothing about permissions on purpose. Nothing reaches
 * `applyUpdate` that has not already been authorised against the database by
 * the connection that received it.
 */
export class BoardRoom {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);

  private readonly members = new Set<RoomMember>();
  private saveTimer: NodeJS.Timeout | null = null;
  private pendingSave = false;
  private writing: Promise<void> = Promise.resolve();
  private disposing = false;

  private constructor(private readonly options: BoardRoomOptions) {
    // The server is a relay, not a participant: it must not appear as a cursor.
    this.awareness.setLocalState(null);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.broadcast(encodeUpdate(update), origin as RoomMember | null);
      if (origin !== HYDRATION_ORIGIN) this.schedulePersist();
    });

    this.awareness.on(
      "update",
      (
        change: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changed = [
          ...change.added,
          ...change.updated,
          ...change.removed,
        ];
        if (origin instanceof Object && "awarenessClientIds" in origin) {
          const member = origin as RoomMember;
          for (const id of change.added) member.awarenessClientIds.add(id);
          for (const id of change.removed) member.awarenessClientIds.delete(id);
        }
        if (changed.length > 0) {
          this.broadcast(encodeAwareness(this.awareness, changed), null);
        }
      },
    );
  }

  get boardId(): string {
    return this.options.boardId;
  }

  get size(): number {
    return this.members.size;
  }

  /** Loads the board from its newest snapshot. */
  static async load(options: BoardRoomOptions): Promise<BoardRoom> {
    const room = new BoardRoom(options);
    const snapshot = await getLatestBoardSnapshot(options.db, options.boardId);
    if (snapshot) {
      Y.applyUpdate(room.doc, snapshot.state, HYDRATION_ORIGIN);
    }
    return room;
  }

  join(member: RoomMember): void {
    this.disposing = false;
    this.members.add(member);
  }

  /** Removes a member and its cursors. Returns true when the room went empty. */
  leave(member: RoomMember): boolean {
    this.members.delete(member);
    if (member.awarenessClientIds.size > 0) {
      removeAwarenessStates(
        this.awareness,
        [...member.awarenessClientIds],
        null,
      );
      member.awarenessClientIds.clear();
    }
    return this.members.size === 0;
  }

  /** Applies an already-authorised update and relays it to the other clients. */
  applyUpdate(update: Uint8Array, origin: RoomMember): void {
    Y.applyUpdate(this.doc, update, origin);
  }

  broadcast(message: Uint8Array, except: RoomMember | null): void {
    for (const member of this.members) {
      if (member === except) continue;
      member.send(message);
    }
  }

  /** Ids of every client currently publishing presence. */
  connectedClientIds(): number[] {
    return [...this.awareness.getStates().keys()];
  }

  private schedulePersist(): void {
    this.pendingSave = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, this.options.snapshotDebounceMs);
    // A pending snapshot must never keep the process alive on shutdown.
    this.saveTimer.unref?.();
  }

  /**
   * Writes the current state. Serialised through `writing` so two flushes never
   * interleave and append snapshots out of order.
   */
  flush(): Promise<void> {
    if (!this.pendingSave) return this.writing;
    this.pendingSave = false;

    this.writing = this.writing.then(async () => {
      const { db, boardId, snapshotHistoryLimit, logger } = this.options;
      try {
        await saveBoardSnapshot(db, boardId, Y.encodeStateAsUpdate(this.doc));
        await touchBoard(db, boardId);
        await pruneBoardSnapshots(db, boardId, snapshotHistoryLimit);
      } catch (error) {
        // Losing a snapshot must not take the class down; the next debounce
        // writes the full state again, so a transient failure self-heals.
        this.pendingSave = true;
        logger.error(`snapshot failed for board ${boardId}`, error);
      }
    });

    return this.writing;
  }

  get isDisposing(): boolean {
    return this.disposing;
  }

  markDisposing(): void {
    this.disposing = true;
  }

  async destroy(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.flush();
    this.awareness.destroy();
    this.doc.destroy();
  }
}
