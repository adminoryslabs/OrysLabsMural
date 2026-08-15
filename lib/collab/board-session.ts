import type { Awareness } from "y-protocols/awareness";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import * as authProtocol from "y-protocols/auth";
import * as decoding from "lib0/decoding";

/**
 * The browser half of the collaboration link.
 *
 * Framework-free on purpose: the React canvas and the test suite drive the very
 * same object, so what the tests prove is what ships.
 *
 * WHY THIS CLASS EXISTS AT ALL — the resynchronisation rule.
 * The server is the authority and rejects updates it does not accept (a frozen
 * board, a student on a read-only board, a removed member). A CRDT has no
 * notion of a refused operation: the client applied it locally before sending
 * it, so once the server drops it the two documents have diverged permanently,
 * and every later update from that client references operations the server
 * never saw. The only sound recovery is to throw the local document away and
 * take the server's copy again, which is exactly what a denial triggers here.
 */

export const MESSAGE_AUTH = 2;

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface CollaboratorIdentity {
  /** Stable per-user; used to colour cursors consistently. */
  id: string;
  name: string;
  color: string;
}

export interface Peer {
  clientId: number;
  id: string;
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
}

export interface BoardSessionOptions {
  /** Base websocket url, e.g. `ws://localhost:1234` or `wss://host/yjs`. */
  serverUrl: string;
  boardId: string;
  identity: CollaboratorIdentity;
  /**
   * (Re)binds the caller to a document. Called once on construction and again
   * after every forced resynchronisation, because the document object itself
   * is replaced.
   */
  onBind(doc: Y.Doc, awareness: Awareness): void;
  /** Called just before the current document is discarded. */
  onUnbind?(): void;
  onStatus?(status: ConnectionStatus): void;
  onSync?(synced: boolean): void;
  onPeers?(peers: Peer[]): void;
  /** The server refused a write. `reason` is the board status it refused with. */
  onDenied?(reason: string): void;
  /** Node test harness injects a `ws` subclass that carries the cookie. */
  WebSocketPolyfill?: typeof WebSocket;
  /**
   * Cross-tab BroadcastChannel sync. Off by default: it would let two tabs of
   * the same user exchange edits without the server ever seeing them, which
   * would quietly bypass the freeze.
   */
  enableBroadcastChannel?: boolean;
}

export class BoardSession {
  private doc!: Y.Doc;
  private provider!: WebsocketProvider;
  private destroyed = false;
  private lastDenialAt = 0;

  constructor(private readonly options: BoardSessionOptions) {
    this.open();
  }

  get document(): Y.Doc {
    return this.doc;
  }

  get awareness(): Awareness {
    return this.provider.awareness;
  }

  get synced(): boolean {
    return this.provider.synced;
  }

  private open(): void {
    const {
      serverUrl,
      boardId,
      identity,
      WebSocketPolyfill,
      enableBroadcastChannel = false,
    } = this.options;

    this.doc = new Y.Doc();
    this.provider = new WebsocketProvider(serverUrl, boardId, this.doc, {
      disableBc: !enableBroadcastChannel,
      ...(WebSocketPolyfill ? { WebSocketPolyfill } : {}),
    });

    // `messageHandlers` is a per-provider copy, so replacing the auth handler
    // here does not leak into any other connection.
    this.provider.messageHandlers[MESSAGE_AUTH] = (
      _encoder: unknown,
      decoder: decoding.Decoder,
    ) => {
      authProtocol.readAuthMessage(decoder, this.doc, (_doc, reason) => {
        this.handleDenied(reason);
      });
    };

    this.provider.on("status", (event: { status: ConnectionStatus }) => {
      this.options.onStatus?.(event.status);
    });
    this.provider.on("sync", (synced: boolean) => {
      this.options.onSync?.(synced);
    });
    this.provider.awareness.on("change", () => this.publishPeers());

    this.provider.awareness.setLocalStateField("user", {
      id: identity.id,
      name: identity.name,
      color: identity.color,
    });

    this.options.onBind(this.doc, this.provider.awareness);
    this.publishPeers();
  }

  private close(): void {
    this.options.onUnbind?.();
    this.provider.awareness.setLocalState(null);
    this.provider.disconnect();
    this.provider.destroy();
    this.doc.destroy();
  }

  /**
   * A refused write means this client is holding operations the server will
   * never accept. Rebuild from scratch and let the server hand back the
   * authoritative board.
   */
  private handleDenied(reason: string): void {
    if (this.destroyed) return;
    const now = Date.now();
    // The server already throttles denials; this guards against a storm.
    if (now - this.lastDenialAt < 1000) return;
    this.lastDenialAt = now;

    this.options.onDenied?.(reason);
    this.close();
    this.open();
  }

  /** Publishes this user's pointer so the others can see it. */
  setCursor(cursor: { x: number; y: number } | null): void {
    if (this.destroyed) return;
    this.provider.awareness.setLocalStateField("cursor", cursor);
  }

  /** Everyone else currently on the board. */
  peers(): Peer[] {
    const localId = this.doc.clientID;
    const peers: Peer[] = [];

    for (const [clientId, state] of this.provider.awareness.getStates()) {
      if (clientId === localId) continue;
      const user = (state as { user?: Partial<CollaboratorIdentity> }).user;
      if (!user?.id) continue;
      const cursor = (state as { cursor?: { x: number; y: number } | null })
        .cursor;
      peers.push({
        clientId,
        id: user.id,
        name: user.name ?? "Someone",
        color: user.color ?? "#64748b",
        cursor: cursor ?? null,
      });
    }

    return peers.sort((a, b) => a.name.localeCompare(b.name));
  }

  private publishPeers(): void {
    this.options.onPeers?.(this.peers());
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.close();
  }
}

/** Deterministic, readable cursor colour derived from the user id. */
export function colorForUser(userId: string): string {
  const palette = [
    "#e11d48",
    "#ea580c",
    "#ca8a04",
    "#16a34a",
    "#0891b2",
    "#2563eb",
    "#7c3aed",
    "#db2777",
  ];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length] ?? "#2563eb";
}
