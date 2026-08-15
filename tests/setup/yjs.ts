import { WebSocket } from "ws";
import type * as Y from "yjs";
import { createSession } from "@/lib/auth/session";
import type { BoardAuthorityState } from "@/lib/collab/status-frame";
import {
  BoardSession,
  type CollaboratorIdentity,
  type ConnectionStatus,
  type Peer,
} from "@/lib/collab/board-session";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session-cookie";
import { createYjsServer, type YjsServer } from "@/yjs-server/server";
import { testDb } from "./db";

/**
 * Boots a real websocket server on an ephemeral port against the real test
 * database. Nothing here is mocked: the tests speak the actual y-websocket
 * protocol over a real TCP socket.
 */
export function startTestServer(
  options: Partial<Parameters<typeof createYjsServer>[0]> = {},
): Promise<YjsServer> {
  return createYjsServer({
    db: testDb,
    host: "127.0.0.1",
    port: 0,
    // Short timers keep the suite fast; production defaults are much longer.
    snapshotDebounceMs: 40,
    heartbeatIntervalMs: 50,
    // Production polls every few seconds; the suite must not wait that long.
    statusPollMs: 40,
    reaperIntervalMs: 0, // disabled unless a test opts in
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...options,
  });
}

/** Issues a real auth session and returns the cookie header a browser would send. */
export async function cookieFor(userId: string): Promise<string> {
  const { token } = await createSession(testDb, userId);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

export interface CloseInfo {
  code: number;
  reason: string;
}

/**
 * Raw protocol-level client. Used by the handshake tests, where the exact close
 * code matters and the reconnect logic of the real provider would get in the way.
 */
export function rawConnect(
  server: YjsServer,
  path: string,
  cookie?: string | null,
): {
  socket: WebSocket;
  opened: Promise<void>;
  closed: Promise<CloseInfo>;
  firstMessage: Promise<Uint8Array>;
} {
  const socket = new WebSocket(`${server.url}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });

  const closed = new Promise<CloseInfo>((resolve) => {
    socket.on("close", (code, reason) =>
      resolve({ code, reason: reason.toString("utf8") }),
    );
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve());
    socket.on("error", reject);
    void closed.then(({ code }) =>
      reject(new Error(`socket closed before opening (${code})`)),
    );
  });
  const firstMessage = new Promise<Uint8Array>((resolve, reject) => {
    socket.once("message", (data) => resolve(new Uint8Array(data as Buffer)));
    void closed.then(({ code, reason }) =>
      reject(new Error(`closed before any message: ${code} ${reason}`)),
    );
  });

  // Nothing in these tests awaits every promise, and an unhandled rejection
  // would fail the run for the wrong reason.
  opened.catch(() => {});
  firstMessage.catch(() => {});

  return { socket, opened, closed, firstMessage };
}

/**
 * `ws` subclass that injects the session cookie, standing in for what a browser
 * does automatically on a same-origin websocket upgrade.
 */
function cookieWebSocket(cookie: string | null) {
  return class CookieWebSocket extends WebSocket {
    constructor(address: string, protocols?: string | string[]) {
      super(address, protocols, cookie ? { headers: { Cookie: cookie } } : {});
    }
  } as unknown as typeof globalThis.WebSocket;
}

export interface TestClient {
  session: BoardSession;
  /** The shared map the tests mutate. Re-read after every resynchronisation. */
  readonly shapes: Y.Map<unknown>;
  /** How many times the server refused a write from this client. */
  readonly denials: number;
  /** The last board status the server pushed to this client. */
  readonly authority: BoardAuthorityState | null;
  /** Every authority push received, in order. */
  readonly authorityUpdates: BoardAuthorityState[];
  /** Every connection status transition, used to prove nothing reconnected. */
  readonly connectionEvents: ConnectionStatus[];
  /**
   * Identity of the current Yjs document. It changes on every forced
   * resynchronisation, so a stable value proves the client was not rebuilt.
   */
  readonly documentId: number;
  peers(): Peer[];
  destroy(): void;
}

/**
 * Drives the real browser client (`BoardSession`), not a hand-rolled stand-in,
 * so the resynchronisation behaviour the tests rely on is the shipped one.
 */
export function createClient(
  server: YjsServer,
  boardId: string,
  cookie: string | null,
  identity: Partial<CollaboratorIdentity> = {},
): TestClient {
  let denials = 0;
  const authorityUpdates: BoardAuthorityState[] = [];
  const connectionEvents: ConnectionStatus[] = [];
  const session = new BoardSession({
    serverUrl: server.url,
    boardId,
    identity: {
      id: identity.id ?? "test-user",
      name: identity.name ?? "Test User",
      color: identity.color ?? "#2563eb",
    },
    WebSocketPolyfill: cookieWebSocket(cookie),
    onBind: () => {},
    onDenied: () => {
      denials += 1;
    },
    onAuthority: (state) => {
      authorityUpdates.push(state);
    },
    onStatus: (status) => {
      connectionEvents.push(status);
    },
  });

  return {
    session,
    get shapes() {
      return session.document.getMap("shapes");
    },
    get denials() {
      return denials;
    },
    get authority() {
      return session.authority;
    },
    get authorityUpdates() {
      return authorityUpdates;
    },
    get connectionEvents() {
      return connectionEvents;
    },
    get documentId() {
      return session.document.clientID;
    },
    peers: () => session.peers(),
    destroy: () => session.destroy(),
  };
}

export async function waitForSync(
  client: TestClient,
  timeoutMs = 5000,
): Promise<void> {
  await waitUntil(() => client.session.synced, {
    timeoutMs,
    label: "the document to synchronise",
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `predicate` holds, or throws. Avoids fixed-length sleeps. */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 25, label = "condition" } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(intervalMs);
  }
}

/**
 * Asserts that a value NEVER arrives. Used for write rejection: the only honest
 * proof that the server dropped an update is that the peer never sees it.
 */
export async function expectNeverArrives(
  predicate: () => boolean,
  windowMs = 600,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      throw new Error("the update was relayed but should have been rejected");
    }
    await sleep(25);
  }
}
