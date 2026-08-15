"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  exportToBlob,
  exportToSvg,
  reconcileElements,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  BinaryFiles,
  Collaborator,
  SocketId,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type * as Y from "yjs";
import { StatusBadge } from "@/components/status-badge";
import type { BoardStatus } from "@/lib/db/schema";
import {
  BoardSession,
  colorForUser,
  type ConnectionStatus,
  type Peer,
} from "@/lib/collab/board-session";
import type { BoardAuthorityState } from "@/lib/collab/status-frame";
import "@excalidraw/excalidraw/index.css";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

// Serve the fonts from this origin instead of the public CDN Excalidraw falls
// back to: the classroom must not depend on an outbound connection.
// `npm run assets` (wired into predev/prebuild) puts them there.
if (typeof window !== "undefined") {
  window.EXCALIDRAW_ASSET_PATH = "/excalidraw/";
}

/** Yjs transaction origin for our own edits, so the observer can ignore them. */
const LOCAL_ORIGIN = "local";

/** Name of the shared map. One entry per element, keyed by element id. */
const ELEMENTS_KEY = "elements";

/** Cursor updates are cheap but constant; 50ms is smooth without flooding. */
const CURSOR_THROTTLE_MS = 50;

/**
 * Excalidraw fires `onChange` on every pointer move of a drag. Broadcasting
 * each one would put ~60 update frames per second per user on the wire and,
 * worse, would count a single drawn rectangle as dozens of "edits" in the
 * participation log. Coalescing on a short trailing timer keeps the latency
 * imperceptible and makes edit_count mean something.
 */
const BROADCAST_THROTTLE_MS = 80;

export interface BoardCanvasProps {
  boardId: string;
  /**
   * What the server decided when this page was rendered. It is only the
   * starting point: the collaboration server pushes the current answer over the
   * socket, so a teacher freezing or unfreezing the board is reflected here
   * without anyone reloading. The websocket server enforces the real rule.
   */
  canWrite: boolean;
  status: BoardStatus;
  user: { id: string; displayName: string };
  /** Websocket base url, `NEXT_PUBLIC_YJS_URL`. */
  serverUrl: string;
  boardTitle: string;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "board"
  );
}

export function BoardCanvasScene({
  boardId,
  canWrite,
  status,
  user,
  serverUrl,
  boardTitle,
}: BoardCanvasProps) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [synced, setSynced] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [refusedReason, setRefusedReason] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  /**
   * The live answer from the collaboration server, seeded with what the page
   * was rendered with. Every later value is pushed by the server.
   */
  const [authority, setAuthority] = useState<BoardAuthorityState>({
    status,
    canWrite,
  });

  const sessionRef = useRef<BoardSession | null>(null);
  const elementsRef = useRef<Y.Map<ExcalidrawElement> | null>(null);
  const docRef = useRef<Y.Doc | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  /**
   * Version of every element as this client last saw it. This is the echo
   * guard: an element whose version we already know is not re-broadcast, so a
   * remote update applied through `updateScene` cannot bounce back out.
   */
  const knownVersions = useRef(new Map<string, number>());
  const lastCursorAt = useRef(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Set when the server refuses a write. The next successful sync must then
   * REPLACE the scene rather than merge into it: the refused shape is still
   * sitting in the local Excalidraw scene, and reconciling would keep it alive
   * even though the shared document has never heard of it.
   */
  const discardLocalScene = useRef(false);

  apiRef.current = api;

  const identity = useMemo(
    () => ({
      id: user.id,
      name: user.displayName,
      color: colorForUser(user.id),
    }),
    [user.id, user.displayName],
  );

  /**
   * Merges the shared document into the local scene. `reconcileElements` is
   * Excalidraw's own rule: the higher `version` wins, and `versionNonce` breaks
   * a tie deterministically, so every client converges on the same scene
   * instead of the last message overwriting whatever was there.
   */
  const applyRemote = useCallback(() => {
    const scene = apiRef.current;
    const shared = elementsRef.current;
    if (!scene || !shared) return;

    const remote = [...shared.values()] as RemoteExcalidrawElement[];
    const replace = discardLocalScene.current;
    if (remote.length === 0 && !replace) return;

    // Reconciling against an empty local scene simply orders the shared
    // elements, which is exactly what "take the server's copy" means.
    const local = replace
      ? []
      : (scene.getSceneElementsIncludingDeleted() as readonly OrderedExcalidrawElement[]);
    const reconciled = reconcileElements(local, remote, scene.getAppState());
    if (replace) {
      discardLocalScene.current = false;
      knownVersions.current.clear();
    }

    for (const element of reconciled) {
      knownVersions.current.set(element.id, element.version);
    }

    scene.updateScene({
      elements: reconciled,
      // A remote edit is not this user's undo history.
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, []);

  // One session for the lifetime of the board page. `onBind` runs again after
  // a forced resynchronisation, because the document object is replaced.
  useEffect(() => {
    let disposed = false;
    let observed: Y.Map<ExcalidrawElement> | null = null;

    const observer = (
      _event: Y.YMapEvent<ExcalidrawElement>,
      transaction: Y.Transaction,
    ) => {
      if (transaction.origin === LOCAL_ORIGIN) return;
      applyRemote();
    };

    const session = new BoardSession({
      serverUrl,
      boardId,
      identity,
      onBind: (doc) => {
        if (disposed) return;
        docRef.current = doc;
        const shared = doc.getMap<ExcalidrawElement>(ELEMENTS_KEY);
        elementsRef.current = shared;
        shared.observe(observer);
        observed = shared;
        // The local scene is stale after a resynchronisation; forget what we
        // thought we knew so the authoritative state is applied in full.
        knownVersions.current.clear();
        applyRemote();
      },
      onUnbind: () => {
        observed?.unobserve(observer);
        observed = null;
        elementsRef.current = null;
      },
      onStatus: (next) => !disposed && setConnection(next),
      onSync: (isSynced) => {
        if (disposed) return;
        setSynced(isSynced);
        if (isSynced) applyRemote();
      },
      onPeers: (next) => !disposed && setPeers(next),
      onAuthority: (state) => {
        if (disposed) return;
        setAuthority(state);
        // The board is writable again: drop the "refused" latch, which is the
        // whole reason a frozen-out student used to need a reload.
        if (state.canWrite) setRefusedReason(null);
      },
      onDenied: (reason) => {
        if (disposed) return;
        // The refused shape is still on this canvas even though the shared
        // document rejected it. Mark the scene for replacement so the next
        // sync shows what the server actually holds.
        discardLocalScene.current = true;
        setRefusedReason(reason);
      },
    });

    sessionRef.current = session;

    return () => {
      disposed = true;
      // `session.destroy()` closes the session, which invokes `onUnbind` and
      // detaches the observer there. Unobserving here as well would take the
      // same handler off twice and make Yjs warn about a handler that is gone.
      session.destroy();
      sessionRef.current = null;
      elementsRef.current = null;
      docRef.current = null;
    };
  }, [boardId, serverUrl, identity, applyRemote]);

  // Excalidraw renders remote cursors natively once it is told who is present.
  useEffect(() => {
    if (!api) return;
    const collaborators = new Map<SocketId, Collaborator>(
      peers.map((peer) => [
        // Excalidraw keys collaborators by an opaque socket id; the Yjs client
        // id is exactly that - one per connected tab.
        String(peer.clientId) as SocketId,
        {
          id: peer.id,
          username: peer.name,
          color: { background: peer.color, stroke: peer.color },
          ...(peer.cursor
            ? { pointer: { ...peer.cursor, tool: "pointer" as const } }
            : {}),
        } satisfies Collaborator,
      ]),
    );
    api.updateScene({ collaborators });
  }, [api, peers]);

  /** Publishes everything the shared document has not seen yet. */
  const flushLocalChanges = useCallback(() => {
    const scene = apiRef.current;
    const shared = elementsRef.current;
    const doc = docRef.current;
    if (!scene || !shared || !doc) return;

    const changed = scene
      .getSceneElementsIncludingDeleted()
      .filter((element) => {
        const known = knownVersions.current.get(element.id);
        return known === undefined || element.version > known;
      });
    if (changed.length === 0) return;

    // One transaction per batch: the server sees a single update frame and
    // counts it as one edit, and peers apply the batch atomically.
    doc.transact(() => {
      for (const element of changed) {
        knownVersions.current.set(element.id, element.version);
        shared.set(element.id, element);
      }
    }, LOCAL_ORIGIN);
  }, []);

  const handleChange = useCallback(() => {
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      flushLocalChanges();
    }, BROADCAST_THROTTLE_MS);
  }, [flushLocalChanges]);

  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );

  // The Excalidraw API arrives after the first render, which can be after the
  // document has already synchronised. Without this the board would render
  // empty until the next remote edit happened to arrive.
  useEffect(() => {
    if (api) applyRemote();
  }, [api, applyRemote]);

  const handlePointerUpdate = useCallback(
    (payload: { pointer: { x: number; y: number } }) => {
      const now = Date.now();
      if (now - lastCursorAt.current < CURSOR_THROTTLE_MS) return;
      lastCursorAt.current = now;
      sessionRef.current?.setCursor(payload.pointer);
    },
    [],
  );

  const exportScene = useCallback(
    async (format: "png" | "svg") => {
      const scene = apiRef.current;
      if (!scene || exporting) return;
      setExporting(true);
      try {
        const elements = scene.getSceneElements();
        const appState = scene.getAppState();
        const files: BinaryFiles = scene.getFiles();
        const name = `${slugify(boardTitle)}.${format}`;

        if (format === "png") {
          const blob = await exportToBlob({
            elements,
            appState: { ...appState, exportWithDarkMode: false },
            files,
            mimeType: "image/png",
            exportPadding: 16,
          });
          downloadBlob(blob, name);
          return;
        }

        const svg = await exportToSvg({
          elements,
          appState: { ...appState, exportWithDarkMode: false },
          files,
          exportPadding: 16,
        });
        downloadBlob(
          new Blob([svg.outerHTML], { type: "image/svg+xml" }),
          name,
        );
      } finally {
        setExporting(false);
      }
    },
    [boardTitle, exporting],
  );

  // A freshly server-rendered page is newer than anything pushed earlier.
  useEffect(() => {
    setAuthority({ status, canWrite });
  }, [status, canWrite]);

  const readOnly = !authority.canWrite || refusedReason !== null;

  return (
    <section className="board-canvas">
      <header className="board-canvas-bar">
        <span
          className={`board-connection board-connection-${connection}`}
          title={`Websocket ${connection}`}
        >
          {connection === "connected"
            ? synced
              ? "Live"
              : "Syncing…"
            : connection === "connecting"
              ? "Connecting…"
              : "Offline"}
        </span>

        {/* Live: this is the status the collaboration server last stated, not
            the one the page was rendered with. */}
        <StatusBadge status={authority.status} />

        <span className="board-presence">
          {peers.length === 0
            ? "You are the only one here"
            : `${peers.length + 1} people on this board`}
        </span>

        <ul className="board-peers">
          {peers.map((peer) => (
            <li key={peer.clientId} className="board-peer">
              <span
                className="board-peer-dot"
                style={{ backgroundColor: peer.color }}
                aria-hidden="true"
              />
              {peer.name}
            </li>
          ))}
        </ul>

        <span className="board-canvas-actions">
          <button
            type="button"
            onClick={() => void exportScene("png")}
            disabled={exporting}
          >
            Export PNG
          </button>
          <button
            type="button"
            onClick={() => void exportScene("svg")}
            disabled={exporting}
          >
            Export SVG
          </button>
        </span>
      </header>

      {refusedReason ? (
        <p className="board-canvas-refused" role="status">
          The server refused your last change: this board is now{" "}
          <strong>{refusedReason}</strong>. The board was reloaded from the
          server, so your change was not saved.
        </p>
      ) : null}

      <div className="board-canvas-surface">
        <Excalidraw
          excalidrawAPI={setApi}
          onChange={handleChange}
          onPointerUpdate={handlePointerUpdate}
          viewModeEnabled={readOnly}
          isCollaborating
          name={boardTitle}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              // Export goes through our own buttons so the filename matches
              // the board and both formats behave identically.
              export: false,
              toggleTheme: true,
            },
          }}
        />
      </div>

      {!authority.canWrite ? (
        <p className="muted board-canvas-note" role="status">
          {authority.status === "frozen"
            ? "This board is frozen. Nobody can edit it, the teacher included."
            : "This board is read only for you. You can watch and export it."}
        </p>
      ) : null}
    </section>
  );
}
