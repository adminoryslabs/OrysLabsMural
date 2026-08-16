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
  BinaryFileData,
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
import { PresenceRow } from "@/components/avatar";
import {
  BoardSessionPanel,
  BoardStateNote,
  BoardTopBar,
  type RosterEntry,
} from "@/components/board-chrome";
import type { BoardStatus } from "@/lib/db/schema";
import {
  BoardSession,
  colorForUser,
  type ConnectionStatus,
  type Peer,
} from "@/lib/collab/board-session";
import type { BoardAuthorityState } from "@/lib/collab/status-frame";
import {
  blobToDataUrl,
  dataUrlToBlob,
  fetchBoardFile,
  referencedFileIds,
  uploadBoardFile,
} from "@/lib/collab/board-files";
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

/** How long after an edit a peer still reads as "Editing" in the roster. */
const EDITING_WINDOW_MS = 5000;

/** Repaint cadence for the two things that age: "Editing" and "saved Ns ago". */
const CLOCK_TICK_MS = 2000;

const PANEL_STORAGE_KEY = "mural.panelOpen";

/**
 * Quiet time before the image sync pass runs. Uploads must never sit in a
 * render path, and pasting a picture fires several `onChange` calls in a row.
 */
const FILE_SYNC_DEBOUNCE_MS = 250;

/**
 * Backstop pass. An element can reach a peer before its bytes finish uploading,
 * so a missing file is normal for a moment; this is also what retries a fetch
 * that lost the race, without any coordination between the two clients.
 */
const FILE_SYNC_INTERVAL_MS = 1500;

/** How many times a still-missing file is asked for before we stop asking. */
const MAX_FILE_FETCH_ATTEMPTS = 12;

function nextVersionNonce(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

export interface BoardMember {
  userId: string;
  displayName: string;
}

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
  /** Whether to offer the state control. The server re-authorises the change. */
  canAdminister: boolean;
  user: { id: string; displayName: string };
  /** Everyone assigned to this board, so the roster can show who is missing. */
  members: readonly BoardMember[];
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

function agoLabel(since: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}

export function BoardCanvasScene({
  boardId,
  canWrite,
  status,
  canAdminister,
  user,
  members,
  serverUrl,
  boardTitle,
}: BoardCanvasProps) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [synced, setSynced] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [refusedReason, setRefusedReason] = useState<string | null>(null);
  /** Why an image was refused. Shown inline instead of leaving it broken. */
  const [fileError, setFileError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  /** Last time the document changed, local or remote. Drives "saved Ns ago". */
  const [lastChangeAt, setLastChangeAt] = useState<number | null>(null);
  /** Ticks so "Editing" and "saved Ns ago" age without a document event. */
  const [clock, setClock] = useState(() => Date.now());
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

  /**
   * IMAGE BOOKKEEPING. The bytes of an image never enter the Yjs document, so
   * this client has to keep track of which files the server already holds and
   * which ones it is still missing locally. All of it lives in refs: none of it
   * belongs in the render, and the sync pass must stay stable for the lifetime
   * of the page so it can never tear the websocket session down.
   */
  /** Files the server is known to hold: uploaded by us, or fetched from it. */
  const serverFileIds = useRef(new Set<string>());
  const uploadsInFlight = useRef(new Set<string>());
  const fetchesInFlight = useRef(new Set<string>());
  /** Files the server refused for good. Never retried, never re-added. */
  const rejectedFileIds = useRef(new Set<string>());
  const fetchAttempts = useRef(new Map<string, number>());
  const fileSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Aborts every in-flight transfer when the board page goes away. */
  const fileTransfers = useRef<AbortController | null>(null);
  /**
   * The live authority, readable from a callback without making that callback
   * depend on it — a changing dependency here would rebuild the session effect
   * and reconnect the socket on every freeze.
   */
  const authorityRef = useRef<BoardAuthorityState>({ status, canWrite });

  apiRef.current = api;
  authorityRef.current = authority;

  /** Set once `flushLocalChanges` exists below; see the note on `flushRef`. */
  const flushRef = useRef<() => void>(() => {});

  const identity = useMemo(
    () => ({
      id: user.id,
      name: user.displayName,
      color: colorForUser(user.id),
    }),
    [user.id, user.displayName],
  );

  /**
   * Takes an image off the canvas because its bytes will never reach the
   * server. Leaving it would be worse than removing it: the element syncs to
   * everyone, so every other student would be left with a picture frame that
   * can never load, on a board that otherwise looks fine.
   *
   * The deletion is a normal edit — version bumped, nonce fresh — so the next
   * flush broadcasts it and the peers who already received the element drop it
   * too.
   */
  const removeImagesForFiles = useCallback((fileIds: ReadonlySet<string>) => {
    const scene = apiRef.current;
    if (!scene || fileIds.size === 0) return;

    let removed = false;
    const elements = scene
      .getSceneElementsIncludingDeleted()
      .map((element) => {
        if (
          element.type !== "image" ||
          element.isDeleted ||
          !element.fileId ||
          !fileIds.has(element.fileId)
        ) {
          return element;
        }
        removed = true;
        return {
          ...element,
          isDeleted: true,
          version: element.version + 1,
          versionNonce: nextVersionNonce(),
        };
      });
    if (!removed) return;

    scene.updateScene({
      elements,
      // Removing something the server refused is not an undo step the user
      // should be able to walk back into.
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    flushRef.current();
  }, []);

  /**
   * ONE PASS OVER THE IMAGES OF THIS BOARD.
   *
   * Two directions, both driven by what the elements reference rather than by
   * any event, which is what makes it safe to run repeatedly and idempotent
   * when it does:
   *
   *   up   - a file this client holds that the server has not been given yet
   *   down - a file an element references that this client does not hold
   *
   * The guard sets make every extra pass free, so it can be triggered
   * generously (on change, on a remote update, and on a slow interval) without
   * ever uploading or downloading the same bytes twice.
   */
  const syncFiles = useCallback(() => {
    const scene = apiRef.current;
    if (!scene) return;
    const signal = fileTransfers.current?.signal;

    const needed = referencedFileIds(scene.getSceneElementsIncludingDeleted());
    if (needed.size === 0) return;
    const local = scene.getFiles();

    for (const fileId of needed) {
      if (rejectedFileIds.current.has(fileId)) continue;
      const file = local[fileId] as BinaryFileData | undefined;

      if (file) {
        // We hold the bytes. Does the server?
        if (serverFileIds.current.has(fileId)) continue;
        if (uploadsInFlight.current.has(fileId)) continue;
        // Uploading is writing. The server enforces this itself on every
        // request; skipping here only avoids a refusal we already expect.
        if (!authorityRef.current.canWrite) continue;

        const blob = dataUrlToBlob(file.dataURL);
        if (!blob) {
          rejectedFileIds.current.add(fileId);
          setFileError("That image could not be read, so it was removed.");
          removeImagesForFiles(new Set([fileId]));
          continue;
        }

        uploadsInFlight.current.add(fileId);
        void uploadBoardFile(boardId, fileId, blob, signal)
          .then((outcome) => {
            if (outcome.ok) {
              serverFileIds.current.add(fileId);
              return;
            }
            if (outcome.retry) return; // the next pass tries again
            rejectedFileIds.current.add(fileId);
            if (outcome.message) setFileError(outcome.message);
            removeImagesForFiles(new Set([fileId]));
          })
          .finally(() => uploadsInFlight.current.delete(fileId));
        continue;
      }

      // An element from a peer whose bytes we have never seen.
      if (fetchesInFlight.current.has(fileId)) continue;
      const attempts = fetchAttempts.current.get(fileId) ?? 0;
      if (attempts >= MAX_FILE_FETCH_ATTEMPTS) continue;
      fetchAttempts.current.set(fileId, attempts + 1);

      fetchesInFlight.current.add(fileId);
      void fetchBoardFile(boardId, fileId, signal)
        .then(async (outcome) => {
          if (!outcome.ok) {
            // A 404 is normal for a moment: the peer who pasted the image may
            // still be uploading it. Anything else is final for this file.
            if (!outcome.retry) {
              fetchAttempts.current.set(fileId, MAX_FILE_FETCH_ATTEMPTS);
            }
            return;
          }
          const dataURL = await blobToDataUrl(outcome.blob);
          serverFileIds.current.add(fileId);
          apiRef.current?.addFiles([
            {
              id: fileId,
              mimeType: outcome.blob.type,
              dataURL,
              created: Date.now(),
            } as BinaryFileData,
          ]);
        })
        .catch(() => {})
        .finally(() => fetchesInFlight.current.delete(fileId));
    }
  }, [boardId, removeImagesForFiles]);

  /** Coalesces the bursts of `onChange` a single paste produces. */
  const scheduleFileSync = useCallback(() => {
    if (fileSyncTimer.current) return;
    fileSyncTimer.current = setTimeout(() => {
      fileSyncTimer.current = null;
      syncFiles();
    }, FILE_SYNC_DEBOUNCE_MS);
  }, [syncFiles]);

  useEffect(() => {
    const controller = new AbortController();
    fileTransfers.current = controller;
    const timer = setInterval(syncFiles, FILE_SYNC_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      if (fileSyncTimer.current) clearTimeout(fileSyncTimer.current);
      fileSyncTimer.current = null;
      controller.abort();
      fileTransfers.current = null;
    };
  }, [syncFiles]);

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

    // An image element may have just arrived without its bytes: they were never
    // in the document. Fetch whatever this client is now missing.
    scheduleFileSync();
  }, [scheduleFileSync]);

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
      setLastChangeAt(Date.now());
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

    // Presence, not authority: it only decides whether the roster says
    // "Editing" next to this person's name on the other screens.
    sessionRef.current?.markEditing();
    setLastChangeAt(Date.now());
  }, []);

  // `removeImagesForFiles` is defined above this and has to broadcast the
  // deletion it makes. Reaching it through a ref keeps both callbacks stable
  // for the lifetime of the page, which is what stops a re-created callback
  // from rebuilding the session effect and reconnecting the socket.
  flushRef.current = flushLocalChanges;

  const handleChange = useCallback(() => {
    // The bytes of a pasted image are local-only until this runs.
    scheduleFileSync();
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      flushLocalChanges();
    }, BROADCAST_THROTTLE_MS);
  }, [flushLocalChanges, scheduleFileSync]);

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

  // Two labels age on their own: keep a slow clock rather than a timer each.
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(PANEL_STORAGE_KEY);
    if (stored === "closed") setPanelOpen(false);
  }, []);

  const togglePanel = useCallback(() => {
    setPanelOpen((open) => {
      window.localStorage.setItem(PANEL_STORAGE_KEY, open ? "closed" : "open");
      return !open;
    });
  }, []);

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
        // Images are only ever in the export if this client has actually
        // fetched their bytes, which the sync pass above is what guarantees:
        // the document alone carries file ids, never pixels.
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

  /**
   * The roster: every board member, plus anyone connected who is not one (a
   * supervising teacher), plus this user. Online first, then by name.
   */
  const roster = useMemo<RosterEntry[]>(() => {
    const byId = new Map<string, RosterEntry>();

    for (const member of members) {
      byId.set(member.userId, {
        userId: member.userId,
        displayName: member.displayName,
        online: false,
        editing: false,
        isSelf: member.userId === user.id,
      });
    }

    byId.set(user.id, {
      userId: user.id,
      displayName: user.displayName,
      online: connection === "connected",
      editing:
        lastChangeAt !== null && clock - lastChangeAt < EDITING_WINDOW_MS,
      isSelf: true,
    });

    for (const peer of peers) {
      const existing = byId.get(peer.id);
      byId.set(peer.id, {
        userId: peer.id,
        displayName: existing?.displayName ?? peer.name,
        online: true,
        editing:
          peer.editingAt !== null && clock - peer.editingAt < EDITING_WINDOW_MS,
        isSelf: false,
      });
    }

    return [...byId.values()].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [members, peers, user.id, user.displayName, connection, lastChangeAt, clock]);

  const onlinePeople = roster.filter((entry) => entry.online);

  const connectionLabel =
    connection !== "connected"
      ? "Reconnecting…"
      : !synced
        ? "Syncing…"
        : `${authority.status === "frozen" ? "Frozen" : "Live"} · ${
            lastChangeAt === null
              ? "up to date"
              : `saved ${agoLabel(lastChangeAt, clock)}`
          }`;

  const connectionDotClass =
    connection !== "connected"
      ? "board-conn-dot board-conn-dot-offline"
      : authority.status === "frozen"
        ? "board-conn-dot board-conn-dot-frozen"
        : "board-conn-dot";

  return (
    <div className="board-screen">
      <BoardTopBar
        boardId={boardId}
        title={boardTitle}
        // Live: the status the collaboration server last stated, not the one
        // the page was rendered with.
        status={authority.status}
        canAdminister={canAdminister}
        backHref={canAdminister ? "/teacher" : "/boards"}
        panelOpen={panelOpen}
        onTogglePanel={togglePanel}
        presence={
          <PresenceRow
            people={onlinePeople}
            max={4}
            label={`${onlinePeople.length} of ${roster.length} here`}
          />
        }
      />

      <BoardStateNote
        status={authority.status}
        canAdminister={canAdminister}
      />

      <div className="board-body">
        <div className="board-canvas-surface">
          <div className="excalidraw-host">
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

          <div className="board-notices">
            {refusedReason ? (
              <p className="board-refused" role="status">
                The server refused your last change: this board is now{" "}
                <strong>{refusedReason}</strong>. The board was reloaded from
                the server, so your change was not saved.
              </p>
            ) : null}

            {fileError ? (
              <p className="board-refused" role="status">
                {fileError}{" "}
                <button
                  type="button"
                  className="board-refused-dismiss"
                  onClick={() => setFileError(null)}
                >
                  Dismiss
                </button>
              </p>
            ) : null}
          </div>

          <div className="board-conn">
            <span className={connectionDotClass} aria-hidden="true" />
            <span>{connectionLabel}</span>
          </div>
        </div>

        {panelOpen ? (
          <BoardSessionPanel
            entries={roster}
            status={authority.status}
            onExport={(format) => void exportScene(format)}
            exporting={exporting}
          />
        ) : null}
      </div>
    </div>
  );
}
