import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { Database } from "@/lib/db";
import { validateSessionToken } from "@/lib/auth/session";
import { readSessionTokenFromCookieHeader } from "@/lib/auth/session-cookie";
import { getBoardAccess } from "@/lib/boards/queries";
import {
  closeStaleBoardSessions,
  startBoardSession,
} from "@/lib/participation/queries";
import {
  CLOSE_GOING_AWAY,
  CLOSE_NOT_FOUND,
  CLOSE_SERVER_ERROR,
  CLOSE_UNAUTHENTICATED,
  REASON_NOT_FOUND,
  REASON_SHUTDOWN,
  REASON_UNAUTHENTICATED,
} from "./close-codes";
import { BoardConnection } from "./connection";
import { consoleLogger, type Logger } from "./logger";
import { BoardRoom } from "./room";

export interface YjsServerOptions {
  db: Database;
  host?: string;
  /** 0 picks an ephemeral port, which is what the tests use. */
  port?: number;
  snapshotDebounceMs?: number;
  snapshotHistoryLimit?: number;
  heartbeatIntervalMs?: number;
  /** 0 disables the periodic stale-session sweep. */
  reaperIntervalMs?: number;
  staleAfterSeconds?: number;
  logger?: Logger;
}

export interface YjsServer {
  readonly port: number;
  /** `ws://host:port`, ready to be handed to a y-websocket provider. */
  readonly url: string;
  roomCount(): number;
  connectionCount(): number;
  close(): Promise<void>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The room name is the last path segment, so both `ws://host:1234/<boardId>`
 * (local development) and `wss://domain/yjs/<boardId>` (Caddy in production)
 * resolve to the same board without a second configuration knob.
 */
export function boardIdFromUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  const path = rawUrl.split("?")[0] ?? "";
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  if (!last) return null;

  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    return null;
  }
  // A board id is always a uuid. Anything else is rejected before it can reach
  // SQL, where a malformed uuid would raise instead of returning "not found".
  return UUID_PATTERN.test(decoded) ? decoded : null;
}

export async function createYjsServer(
  options: YjsServerOptions,
): Promise<YjsServer> {
  const {
    db,
    host = "0.0.0.0",
    port = 1234,
    snapshotDebounceMs = 2000,
    snapshotHistoryLimit = 20,
    heartbeatIntervalMs = 20_000,
    reaperIntervalMs = 60_000,
    staleAfterSeconds = 120,
    logger = consoleLogger,
  } = options;

  const rooms = new Map<string, Promise<BoardRoom>>();
  const connections = new Set<BoardConnection>();
  let shuttingDown = false;

  const httpServer = createServer((request, response) => {
    // The only HTTP surface: a health probe for the compose healthcheck.
    if (request.url === "/health" || request.url === "/yjs/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    response.writeHead(426, { "content-type": "text/plain" });
    response.end("This endpoint speaks websockets only.");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

  function acquireRoom(boardId: string): Promise<BoardRoom> {
    const existing = rooms.get(boardId);
    if (existing) return existing;

    const loading = BoardRoom.load({
      db,
      boardId,
      snapshotDebounceMs,
      snapshotHistoryLimit,
      logger,
    }).catch((error) => {
      rooms.delete(boardId);
      throw error;
    });
    rooms.set(boardId, loading);
    return loading;
  }

  async function releaseRoomIfEmpty(boardId: string): Promise<void> {
    const pending = rooms.get(boardId);
    if (!pending) return;
    const room = await pending;
    if (room.size > 0) return;

    room.markDisposing();
    await room.flush();
    // A client may have joined while the snapshot was being written; in that
    // case `join` cleared the flag and the room must stay alive.
    if (room.isDisposing && room.size === 0 && rooms.get(boardId) === pending) {
      rooms.delete(boardId);
      await room.destroy();
    }
  }

  /**
   * HANDSHAKE AUTHORISATION.
   *
   * The upgrade is completed first and the socket is then closed with an
   * explicit code, so the browser client can tell "log in again" from "that
   * board is not yours" - and so both refusals look identical from outside.
   */
  async function admit(socket: WebSocket, request: IncomingMessage) {
    // The socket is paused by the upgrade handler. Authorising a handshake
    // takes two database round trips, and the client sends its first sync
    // frame the instant the upgrade completes: without this pause that frame
    // would arrive before any listener exists and be dropped, leaving the
    // client connected but never synchronised.
    const reject = (code: number, reason: string) => {
      socket.resume();
      socket.close(code, reason);
    };

    const token = readSessionTokenFromCookieHeader(request.headers.cookie);
    if (!token) {
      reject(CLOSE_UNAUTHENTICATED, REASON_UNAUTHENTICATED);
      return;
    }

    const { user } = await validateSessionToken(db, token);
    if (!user) {
      reject(CLOSE_UNAUTHENTICATED, REASON_UNAUTHENTICATED);
      return;
    }

    const boardId = boardIdFromUrl(request.url);
    if (!boardId) {
      reject(CLOSE_NOT_FOUND, REASON_NOT_FOUND);
      return;
    }

    const access = await getBoardAccess(db, boardId, user.id);
    // Identical refusal for "no such board" and "not your board": membership
    // must not be probeable, exactly like Phase A's notFound().
    if (!access || !access.canView) {
      reject(CLOSE_NOT_FOUND, REASON_NOT_FOUND);
      return;
    }

    const room = await acquireRoom(boardId);
    if (socket.readyState !== socket.OPEN) {
      await releaseRoomIfEmpty(boardId);
      return;
    }

    // One participation row per connection, so two tabs stay distinguishable.
    const connectionId = randomUUID();
    const session = await startBoardSession(db, {
      boardId,
      userId: user.id,
      connectionId,
    });

    const connection = new BoardConnection({
      socket,
      room,
      db,
      boardId,
      userId: user.id,
      sessionId: session.id,
      heartbeatIntervalMs,
      logger,
      onClosed: async (closedConnection) => {
        connections.delete(closedConnection);
        if (!shuttingDown) await releaseRoomIfEmpty(boardId);
      },
    });

    connections.add(connection);
    connection.start();
    // Listeners are in place: let the buffered frames through.
    socket.resume();
    logger.info(
      `${user.displayName} joined board ${boardId} (${access.canWrite ? "write" : "read"})`,
    );
  }

  httpServer.on("upgrade", (request, socket, head) => {
    if (shuttingDown) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.pause();
      admit(ws, request).catch((error) => {
        logger.error("handshake failed", error);
        ws.resume();
        ws.close(CLOSE_SERVER_ERROR, "server error");
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const boundPort = (httpServer.address() as AddressInfo).port;

  let reaper: NodeJS.Timeout | null = null;
  if (reaperIntervalMs > 0) {
    reaper = setInterval(() => {
      void closeStaleBoardSessions(db, { staleAfterSeconds })
        .then((closed) => {
          if (closed > 0) logger.info(`closed ${closed} stale board sessions`);
        })
        .catch((error) => logger.error("stale session sweep failed", error));
    }, reaperIntervalMs);
    reaper.unref?.();
  }

  logger.info(`listening on ${host}:${boundPort}`);

  return {
    port: boundPort,
    url: `ws://${host === "0.0.0.0" ? "127.0.0.1" : host}:${boundPort}`,
    roomCount: () => rooms.size,
    connectionCount: () => connections.size,
    async close() {
      shuttingDown = true;
      if (reaper) clearInterval(reaper);

      // Close every participation row before the process goes away, otherwise
      // a restart would leave sessions open until the reaper notices.
      await Promise.all(
        [...connections].map(async (connection) => {
          connection.close(CLOSE_GOING_AWAY, REASON_SHUTDOWN);
          await connection.dispose();
        }),
      );
      connections.clear();

      await Promise.all(
        [...rooms.values()].map(async (pending) => {
          const room = await pending.catch(() => null);
          await room?.destroy();
        }),
      );
      rooms.clear();

      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

export { type Server as HttpServer };
