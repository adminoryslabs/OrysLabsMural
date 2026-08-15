import type { WebSocket } from "ws";
import { applyAwarenessUpdate } from "y-protocols/awareness";
import type { Database } from "@/lib/db";
import { getBoardAccess } from "@/lib/boards/queries";
import {
  encodeBoardStatus,
  type BoardAuthorityState,
} from "@/lib/collab/status-frame";
import {
  endBoardSession,
  recordBoardActivity,
} from "@/lib/participation/queries";
import { CLOSE_NOT_FOUND, REASON_NOT_FOUND } from "./close-codes";
import type { Logger } from "./logger";
import {
  decodeMessage,
  encodeAwareness,
  encodePermissionDenied,
  encodeSyncStep1,
  encodeSyncStep2,
  isEmptyUpdate,
} from "./protocol";
import type { BoardRoom, RoomMember } from "./room";

/** How often a rejected client is told again that it may not write. */
const DENIAL_NOTICE_INTERVAL_MS = 2000;

export interface BoardConnectionOptions {
  socket: WebSocket;
  room: BoardRoom;
  db: Database;
  boardId: string;
  userId: string;
  /** Row id in `board_sessions`; this connection's attribution record. */
  sessionId: string;
  /** What the handshake decided, so the client knows before it draws anything. */
  initialAuthority: BoardAuthorityState;
  heartbeatIntervalMs: number;
  logger: Logger;
  onClosed(connection: BoardConnection): Promise<void> | void;
}

/**
 * One authenticated websocket.
 *
 * THE AUTHORITY RULE LIVES HERE: every frame that carries a document write is
 * re-authorised against the database before it is applied. There is no cached
 * verdict, because the teacher can freeze the board at any moment from the
 * Next.js panel and the freeze has to bite on the very next update. Read
 * traffic (sync step 1, awareness) does not pay for that round trip.
 */
export class BoardConnection implements RoomMember {
  readonly awarenessClientIds = new Set<number>();

  /** Serialises message handling so awaits cannot interleave two frames. */
  private queue: Promise<void> = Promise.resolve();
  private uncountedEdits = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastDenialNoticeAt = 0;
  private closed = false;
  /** Last status pushed to this client; used to avoid repeating ourselves. */
  private announced: BoardAuthorityState | null = null;

  constructor(private readonly options: BoardConnectionOptions) {
    const { socket } = options;
    socket.binaryType = "nodebuffer";

    socket.on("message", (data: Buffer) => {
      this.enqueue(() => this.handleMessage(new Uint8Array(data)));
    });
    socket.on("close", () => void this.dispose());
    socket.on("error", (error) => {
      options.logger.warn("socket error", error);
      void this.dispose();
    });

    if (options.heartbeatIntervalMs > 0) {
      this.heartbeat = setInterval(
        () => void this.beat(),
        options.heartbeatIntervalMs,
      );
      this.heartbeat.unref?.();
    }
  }

  get boardId(): string {
    return this.options.boardId;
  }

  /** Opening handshake: our state vector, plus everyone already present. */
  start(): void {
    const { room } = this.options;
    room.join(this);
    // The sync handshake still opens the conversation, so a client that knows
    // nothing of board status is unaffected.
    this.send(encodeSyncStep1(room.doc));

    const present = room.connectedClientIds();
    if (present.length > 0) {
      this.send(encodeAwareness(room.awareness, present));
    }

    // Then: what this client may actually do. The page was server rendered at
    // some earlier point, so its idea of the status may already be stale by the
    // time the socket opens.
    this.announce(this.options.initialAuthority);
  }

  send(message: Uint8Array): void {
    const { socket } = this.options;
    if (this.closed || socket.readyState !== socket.OPEN) return;
    socket.send(message, (error) => {
      if (error) void this.dispose();
    });
  }

  /**
   * Re-reads this connection's access and tells the client what it may do now.
   *
   * Called when the board's status changes, which is the only moment the
   * verdict can flip while the client is idle. It is the same
   * `getBoardAccess` the write path uses: the pushed value is derived from the
   * database, never from anything the client said.
   */
  refreshAuthority(): void {
    this.enqueue(async () => {
      if (this.closed) return;
      const { db, boardId, userId } = this.options;
      const access = await getBoardAccess(db, boardId, userId);
      if (!access || !access.canView) {
        // The board is gone, or this user is no longer allowed on it. Same
        // refusal as the handshake, so membership stays unprobeable.
        this.close(CLOSE_NOT_FOUND, REASON_NOT_FOUND);
        return;
      }
      this.announce({
        status: access.board.status,
        canWrite: access.canWrite,
      });
    });
  }

  /** Sends a status frame, unless this client already knows exactly that. */
  private announce(state: BoardAuthorityState): void {
    if (
      this.announced?.status === state.status &&
      this.announced.canWrite === state.canWrite
    ) {
      return;
    }
    this.announced = state;
    this.send(encodeBoardStatus(state));
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error) => {
      this.options.logger.error("message handling failed", error);
    });
  }

  private async handleMessage(data: Uint8Array): Promise<void> {
    if (this.closed) return;
    const { room } = this.options;
    const message = decodeMessage(data);

    switch (message.kind) {
      case "sync-step-1":
        // Read-only: hand the peer whatever it is missing.
        this.send(encodeSyncStep2(room.doc, message.stateVector));
        return;

      case "sync-update":
        await this.handleWrite(message.update);
        return;

      case "awareness":
        // Presence is not a document write: a read-only student still gets a
        // cursor, which is the point of watching a live class.
        applyAwarenessUpdate(room.awareness, message.update, this);
        return;

      case "query-awareness":
        this.send(encodeAwareness(room.awareness, room.connectedClientIds()));
        return;

      case "ignored":
        return;
    }
  }

  private async handleWrite(update: Uint8Array): Promise<void> {
    // A fresh client announces an empty document on connect. That is not an
    // edit, and refusing it would flash a false "permission denied" at anyone
    // opening a frozen board.
    if (isEmptyUpdate(update)) return;

    const { db, boardId, userId, room } = this.options;
    const access = await getBoardAccess(db, boardId, userId);

    if (!access || !access.canView) {
      // Access was revoked, or the board was deleted, while connected.
      this.close(CLOSE_NOT_FOUND, REASON_NOT_FOUND);
      return;
    }

    // The check has already been paid for, so keep the client's hint honest.
    this.announce({ status: access.board.status, canWrite: access.canWrite });

    if (!access.canWrite) {
      this.notifyDenied(access.board.status);
      return;
    }

    room.applyUpdate(update, this);
    this.uncountedEdits += 1;
  }

  private notifyDenied(status: string): void {
    const now = Date.now();
    if (now - this.lastDenialNoticeAt < DENIAL_NOTICE_INTERVAL_MS) return;
    this.lastDenialNoticeAt = now;
    this.send(encodePermissionDenied(status));
  }

  /**
   * Heartbeat. It runs whether or not anything was drawn: `last_seen_at` is what
   * stops an abandoned tab from accruing presence time forever.
   */
  private async beat(): Promise<void> {
    if (this.closed) return;
    const edits = this.uncountedEdits;
    this.uncountedEdits = 0;
    try {
      await recordBoardActivity(this.options.db, this.options.sessionId, {
        edits,
      });
    } catch (error) {
      // Do not lose the edits if the database blinked.
      this.uncountedEdits += edits;
      this.options.logger.error("heartbeat failed", error);
    }
  }

  close(code: number, reason: string): void {
    try {
      this.options.socket.close(code, reason);
    } catch {
      this.options.socket.terminate();
    }
  }

  /** Idempotent teardown: closes the participation row exactly once. */
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }

    this.options.room.leave(this);
    const edits = this.uncountedEdits;
    this.uncountedEdits = 0;

    try {
      await endBoardSession(this.options.db, this.options.sessionId, { edits });
    } catch (error) {
      this.options.logger.error("could not close the board session", error);
    }

    // The server owns room disposal: it is the only place that knows whether
    // another connection is still holding the board open.
    await this.options.onClosed(this);
  }
}
