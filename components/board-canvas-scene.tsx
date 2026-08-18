"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  convertToExcalidrawElements,
  exportToBlob,
  exportToSvg,
  reconcileElements,
  viewportCoordsToSceneCoords,
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
  ExcalidrawTextElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type * as Y from "yjs";
import { PresenceRow } from "@/components/avatar";
import {
  BoardSessionPanel,
  BoardStateNote,
  BoardTopBar,
  IconTool,
  StickyNoteTool,
  type RosterEntry,
} from "@/components/board-chrome";
import {
  DEFAULT_STICKY_NOTE_COLOR,
  STICKY_NOTE_COLOR_STORAGE_KEY,
  isStickyNote,
  nextStickyFontSize,
  readStickyNoteColor,
  recolourSelectedStickyNotes,
  shouldCreateStickyNote,
  stickyNoteOrigin,
  stickyNoteSkeleton,
  viewportCentre,
  type StickyNoteColor,
} from "@/lib/collab/sticky-note";
import {
  findIcon,
  iconDownloadUrl,
  iconOrigin,
  ICON_SIZE,
  type IconCatalogEntry,
} from "@/lib/collab/icon-tool";
import { image as imageElement } from "@/lib/collab/elements";
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

/**
 * How long a note stays correctable after its text editor closes.
 *
 * Excalidraw commits the text and re-lays the container out on the way out of
 * the editor, so the last — and often the only — overflow of a paste arrives
 * after `editingTextElement` has already gone back to null. Without a tail that
 * final growth would never be answered. It is deliberately short: the tail is
 * also the only window in which this client would touch a note it is no longer
 * typing into.
 */
const STICKY_CORRECTION_TAIL_MS = 1500;

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
  /**
   * The global icon bank, fetched once from `/api/icons`. Starts empty rather
   * than undefined so `IconTool` always has an array to render — a teacher
   * adding an icon mid-class does not reach an open tab until it reloads,
   * which is an acceptable staleness window for a picker, unlike board content.
   */
  const [iconCatalog, setIconCatalog] = useState<readonly IconCatalogEntry[]>(
    [],
  );
  /** Colour of the next sticky note. Restored from localStorage on mount. */
  const [stickyColor, setStickyColor] = useState<StickyNoteColor>(
    DEFAULT_STICKY_NOTE_COLOR,
  );
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
  /**
   * The chosen sticky colour, readable from `createStickyNote` without making
   * that callback depend on it — a changing dependency would re-bind the
   * document-level shortcut listener on every swatch click.
   */
  const stickyColorRef = useRef<StickyNoteColor>(DEFAULT_STICKY_NOTE_COLOR);
  /**
   * Whether this client may edit right now: the live authority, minus the local
   * latch set when the server refused a write. Same value the canvas's
   * `viewModeEnabled` uses, so the sticky tool can never be live on a canvas
   * that is not. Enforcement still happens on the server, every update.
   */
  const canEditRef = useRef(canWrite);
  /** The element Excalidraw renders into. Only the synthetic Enter reads it. */
  const hostRef = useRef<HTMLDivElement | null>(null);

  apiRef.current = api;
  authorityRef.current = authority;
  stickyColorRef.current = stickyColor;

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

  // ---- Sticky notes: shrink the text instead of growing the note --------

  /**
   * WHY THIS EXISTS AT ALL.
   *
   * When bound text does not fit, Excalidraw grows the rectangle. That is
   * deliberate upstream behaviour, not a bug (excalidraw/excalidraw#4450: "We
   * went with expand-element-height instead of resize-text-to-fit"), and there
   * is no public flag to turn it off. A wall of differently sized notes stops
   * reading as a grid, which is the entire point of the tool.
   *
   * So it is corrected here, reactively, in our own code: we do not predict
   * Excalidraw's layout, we let it run and answer the result. A note that grew
   * gets one font step taken off and its height put back, and Excalidraw's next
   * layout is the oracle for whether that was enough. Nothing is forked, nothing
   * is patched, and no measurement function is imported — the package's
   * `exports` map publishes its subpaths as TYPES ONLY, with no JS behind them,
   * so `measureText` and `wrapText` do not exist at runtime.
   *
   * The decision itself is `nextStickyFontSize`, a pure function in
   * `lib/collab/sticky-note.ts`; everything here is the side effects.
   */

  /**
   * THE CONCURRENCY RULE: a note is corrected only by the client that has that
   * note's text open in its own editor, plus a short tail for the commit.
   *
   * Every one of the 25 browsers runs `onChange`, and a note that grew reaches
   * all of them. If they all answered it, they would all bump the version, all
   * broadcast, and reconciliation would pick a winner between corrections that
   * were never in conflict — 25 update frames for one keystroke. But
   * `editingTextElement` is app state: it is per browser, it never enters the
   * Yjs document, and only one client can be typing into a given note. So this
   * ref is non-null on exactly one machine at a time, and a note arriving from a
   * peer — through `applyRemote`, which is the only other way a note changes
   * here — matches no session and is left alone.
   *
   * `targetHeight` is captured when the editor opens rather than fixed at
   * `STICKY_NOTE_SIZE`: nobody can drag a note's handles while typing into it,
   * so the height at that moment is the size the user last chose, and a note
   * somebody resized by hand keeps the size they gave it.
   */
  const stickyEditingRef = useRef<{
    containerId: string;
    targetHeight: number;
    /** When the editor closed, or null while it is still open. */
    endedAt: number | null;
  } | null>(null);

  /**
   * The last correction made to a note, and the text it was made against. This
   * is what makes the loop terminate on something other than the font floor: if
   * a step bought no height at all against the same text, the next one will not
   * either. Keyed by text so ordinary typing — where the note legitimately
   * needs another step — is never mistaken for oscillation.
   */
  const stickyAttemptsRef = useRef(
    new Map<string, { text: string; height: number; fontSize: number }>(),
  );

  /** At most one correction in flight; `updateScene` re-enters `onChange`. */
  const stickyCorrectionFrame = useRef<number | null>(null);

  /**
   * SPIKE INSTRUMENTATION. How many corrections this tab has broadcast, so the
   * cost of the feature can be read off the console instead of guessed at.
   * Delete this and its two uses before any of this ships.
   */
  const stickyCorrectionCount = useRef(0);

  const correctStickyOverflow = useCallback(() => {
    const scene = apiRef.current;
    if (!scene) return;
    // The authority path is untouched by this feature: a board this client may
    // not write to gets no corrections at all. Same value `viewModeEnabled`
    // uses, and the collaboration server would drop the update regardless.
    if (!canEditRef.current) return;

    const now = Date.now();
    const appState = scene.getAppState();
    const editing = appState.editingTextElement;
    const editingContainerId =
      editing !== null && editing.type === "text" && editing.containerId
        ? editing.containerId
        : null;

    const elements = scene.getSceneElementsIncludingDeleted();
    let session = stickyEditingRef.current;

    if (editingContainerId !== null) {
      if (session === null || session.containerId !== editingContainerId) {
        const opened = elements.find((el) => el.id === editingContainerId);
        // A hand-drawn rectangle with bound text keeps Excalidraw's native
        // growth behaviour. This is the sticky-note tool, not a change to how
        // text behaves in every shape on the board.
        if (!opened || !isStickyNote(opened)) {
          stickyEditingRef.current = null;
          return;
        }
        session = {
          containerId: editingContainerId,
          targetHeight: opened.height,
          endedAt: null,
        };
        stickyAttemptsRef.current.delete(editingContainerId);
      } else {
        session.endedAt = null;
      }
    } else if (session !== null) {
      if (session.endedAt === null) {
        session.endedAt = now;
      } else if (now - session.endedAt > STICKY_CORRECTION_TAIL_MS) {
        stickyAttemptsRef.current.delete(session.containerId);
        session = null;
      }
    }

    stickyEditingRef.current = session;
    if (session === null) return;
    const active = session;

    const container = elements.find((el) => el.id === active.containerId);
    if (!container || container.isDeleted || !isStickyNote(container)) {
      stickyAttemptsRef.current.delete(active.containerId);
      stickyEditingRef.current = null;
      return;
    }

    const boundTextId = container.boundElements?.find(
      (bound) => bound.type === "text",
    )?.id;
    const found = boundTextId
      ? elements.find((el) => el.id === boundTextId && el.type === "text")
      : undefined;
    if (!found || found.isDeleted) return;
    const boundText = found as ExcalidrawTextElement;

    const attempt = stickyAttemptsRef.current.get(container.id);
    const sameText =
      attempt !== undefined && attempt.text === boundText.originalText;

    const decision = nextStickyFontSize({
      isStickyNote: true,
      height: container.height,
      targetHeight: active.targetHeight,
      fontSize: boundText.fontSize,
      previousAttempt: sameText
        ? { height: attempt.height, fontSize: attempt.fontSize }
        : null,
    });

    if (decision.action !== "shrink") return;

    stickyAttemptsRef.current.set(container.id, {
      text: boundText.originalText,
      height: container.height,
      fontSize: decision.fontSize,
    });

    /**
     * The text element is scaled with the font rather than left for Excalidraw
     * to lay out again. Its `text` already carries the line breaks Excalidraw
     * chose at the old size, and glyph advances and line height are both linear
     * in `fontSize`, so the same wrap points at a smaller size occupy exactly
     * this much less room. If Excalidraw does re-lay the container out it
     * overwrites all four numbers, which is the outcome we want anyway.
     */
    const ratio = decision.fontSize / boundText.fontSize;
    const textWidth = boundText.width * ratio;
    const textHeight = boundText.height * ratio;

    const next = elements.map((element) => {
      if (element.id === container.id) {
        return {
          ...element,
          height: active.targetHeight,
          version: element.version + 1,
          versionNonce: nextVersionNonce(),
        };
      }
      if (element.id === boundText.id) {
        return {
          ...element,
          fontSize: decision.fontSize,
          width: textWidth,
          height: textHeight,
          // Centred by hand for the same reason the size is scaled by hand.
          x: container.x + (container.width - textWidth) / 2,
          y: container.y + (active.targetHeight - textHeight) / 2,
          version: element.version + 1,
          versionNonce: nextVersionNonce(),
        };
      }
      return element;
    }) as ExcalidrawElement[];

    stickyCorrectionCount.current += 1;
    console.debug(
      `[sticky-shrink] ${container.id.slice(0, 8)} ${boundText.fontSize}px -> ` +
        `${decision.fontSize}px (grew to ${Math.round(container.height)}, ` +
        `target ${Math.round(active.targetHeight)}); ` +
        `${stickyCorrectionCount.current} correction(s) this tab`,
    );

    scene.updateScene({
      elements: next,
      // A correction is not a user action. Without this, Ctrl+Z would step back
      // through every shrink iteration instead of undoing what was typed.
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, []);

  /**
   * Deferred to the next frame: `onChange` runs inside Excalidraw's own update,
   * and the correction is a reaction to a layout that has already happened, not
   * part of it. The ref also collapses the burst of `onChange` calls a single
   * paste produces into one correction pass.
   */
  const scheduleStickyCorrection = useCallback(() => {
    if (stickyCorrectionFrame.current !== null) return;
    stickyCorrectionFrame.current = requestAnimationFrame(() => {
      stickyCorrectionFrame.current = null;
      correctStickyOverflow();
    });
  }, [correctStickyOverflow]);

  useEffect(
    () => () => {
      if (stickyCorrectionFrame.current !== null) {
        cancelAnimationFrame(stickyCorrectionFrame.current);
      }
    },
    [],
  );

  const handleChange = useCallback(() => {
    // The bytes of a pasted image are local-only until this runs.
    scheduleFileSync();
    // A sticky note Excalidraw has just grown is put back, one font step
    // smaller. Costs one `find` over the scene when nothing is being typed.
    scheduleStickyCorrection();
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      flushLocalChanges();
    }, BROADCAST_THROTTLE_MS);
  }, [flushLocalChanges, scheduleFileSync, scheduleStickyCorrection]);

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

  // Fetched once: the picker's catalog does not need to track a mid-session
  // addition, and refetching on every open would add a round trip to a click
  // that today's `syncFiles`-based upload path never needed.
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/icons", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : []))
      .then((catalog: IconCatalogEntry[]) => setIconCatalog(catalog))
      .catch(() => {
        // Leaves the catalog empty; IconTool already renders that as
        // "no icons yet" rather than crashing or hanging on a spinner.
      });
    return () => controller.abort();
  }, []);

  const togglePanel = useCallback(() => {
    setPanelOpen((open) => {
      window.localStorage.setItem(PANEL_STORAGE_KEY, open ? "closed" : "open");
      return !open;
    });
  }, []);

  // ---- Sticky notes ------------------------------------------------------

  useEffect(() => {
    setStickyColor(
      readStickyNoteColor(
        window.localStorage.getItem(STICKY_NOTE_COLOR_STORAGE_KEY),
      ),
    );
  }, []);

  /**
   * THE FRAGILE PART, AND THE ONLY ONE.
   *
   * Excalidraw enters text editing on `Enter` when exactly one valid text
   * container is selected — that is its own binding, in its own `onKeyDown`.
   * There is no public way to ask for it: `ExcalidrawImperativeAPI` exposes
   * `updateScene`, `getAppState`, `getSceneElements`, `history`, `scrollToContent`
   * and friends, and nothing that opens the editor. So we synthesise the key
   * press its handler is already listening for.
   *
   * Everything about this is best effort:
   *
   *   - it is deferred to the next frame, because the selection we just asked
   *     for is React state and is not committed yet when this call returns;
   *   - it bails if the selection did not land, so it can never type into the
   *     wrong element;
   *   - it never throws, and it is never awaited or checked by the caller.
   *
   * IF A FUTURE EXCALIDRAW UPGRADE BREAKS THIS: nothing else breaks. The note is
   * already inserted and selected, and the user presses Enter themselves — which
   * is Excalidraw's documented behaviour and one keystroke. Delete this function
   * and its call, or replace it with the imperative API if one ever appears.
   * Do not "fix" it by reaching into Excalidraw's internals.
   */
  const tryEnterTextEditing = useCallback((noteId: string) => {
    requestAnimationFrame(() => {
      try {
        const scene = apiRef.current;
        const container =
          hostRef.current?.querySelector<HTMLElement>(".excalidraw-container");
        if (!scene || !container) return;

        // Only if the note really is the one and only selection.
        const selected = scene.getAppState().selectedElementIds;
        const ids = Object.keys(selected).filter((id) => selected[id]);
        if (ids.length !== 1 || ids[0] !== noteId) return;

        container.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
      } catch {
        // Degrade silently: the note stays selected and the user presses Enter.
      }
    });
  }, []);

  /**
   * Two gestures instead of four: this is the whole point of the feature.
   *
   * The note is built by `convertToExcalidrawElements` rather than by hand, so
   * Excalidraw generates `version`, `versionNonce` and `seed` — the three fields
   * the reconciliation in `applyRemote` uses to decide whose copy of an element
   * wins. It is inserted with `updateScene`, which fires `onChange`, which is
   * the existing coalesce-and-broadcast path: a note reaches the class exactly
   * the way a rectangle does, and there is no new synchronisation code here.
   */
  const createStickyNote = useCallback(() => {
    const scene = apiRef.current;
    if (!scene) return;
    // A reflection of the server's answer, not the decision: the collaboration
    // server drops the update anyway if this board is not writable.
    if (!canEditRef.current) return;

    const appState = scene.getAppState();
    // Where the user is actually looking. The scene origin would drop notes off
    // screen for anyone who has scrolled.
    const centre = viewportCoordsToSceneCoords(
      viewportCentre(appState),
      appState,
    );
    const id = crypto.randomUUID();

    const created = convertToExcalidrawElements(
      [stickyNoteSkeleton(stickyColorRef.current, stickyNoteOrigin(centre), id)],
      // Keep the id we generated: it is how the note is selected below and how
      // the text editing attempt knows it is looking at the right element.
      { regenerateIds: false },
    );
    if (created.length === 0) return;

    scene.updateScene({
      elements: [...scene.getSceneElementsIncludingDeleted(), ...created],
      appState: { selectedElementIds: { [id]: true } },
      // Creating a note is a step the user should be able to undo.
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    tryEnterTextEditing(id);
  }, [tryEnterTextEditing]);

  /**
   * The catalog state, readable from `createIcon` without making that
   * callback depend on it — the same reasoning as `stickyColorRef`.
   */
  const iconCatalogRef = useRef<readonly IconCatalogEntry[]>([]);
  iconCatalogRef.current = iconCatalog;

  /**
   * Places one catalog icon at the centre of the current view.
   *
   * The bytes come from the global icon bank over HTTP (`/api/icons/:fileId`,
   * see `lib/icons/icon-http.ts`), registered locally with `scene.addFiles`
   * exactly like a pasted image would be. No upload call happens here:
   * `syncFiles` already scans the scene for a file this client holds that the
   * *board's* server does not, on every change and on its own interval, and
   * uploads it through the existing `POST /api/boards/:boardId/files` route —
   * the same path a pasted picture takes. Placing the element is what
   * triggers that scan, via `onChange`.
   */
  const createIcon = useCallback((name: string) => {
    const scene = apiRef.current;
    if (!scene) return;
    if (!canEditRef.current) return;

    const icon = findIcon(iconCatalogRef.current, name);
    if (!icon) return;

    void fetch(iconDownloadUrl(icon.fileId))
      .then((response) => {
        // `fetch` only rejects on a network failure, never on a 404 — an
        // unchecked status would let a missing catalog asset decode straight
        // into `blobToDataUrl` and place a corrupt "icon" for the whole class.
        if (!response.ok) {
          throw new Error(`Icon "${name}" could not be loaded (${response.status}).`);
        }
        return response.blob();
      })
      .then(async (blob) => {
        const dataURL = await blobToDataUrl(blob);
        const live = apiRef.current;
        if (!live || !canEditRef.current) return;

        live.addFiles([
          {
            id: icon.fileId,
            // The catalog now accepts any of the allowed image formats, not
            // just PNG, so the type has to come from the response rather than
            // being assumed.
            mimeType: blob.type || "image/png",
            dataURL,
            created: Date.now(),
          } as BinaryFileData,
        ]);

        const appState = live.getAppState();
        const centre = viewportCoordsToSceneCoords(
          viewportCentre(appState),
          appState,
        );
        const origin = iconOrigin(centre);
        const element = imageElement(
          { x: origin.x, y: origin.y, w: ICON_SIZE, h: ICON_SIZE },
          icon.fileId,
        );

        live.updateScene({
          elements: [...live.getSceneElementsIncludingDeleted(), element],
          appState: { selectedElementIds: { [element.id]: true } },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      })
      .catch(() => {
        // Same failure contract `syncFiles` uses for an unreadable image: tell
        // the user rather than leaving the click looking like it did nothing.
        setFileError("That icon could not be loaded.");
      });
  }, []);

  /**
   * A swatch click always sets the colour of the next note, and repaints the
   * sticky notes selected right now. The rule itself is in
   * `recolourSelectedStickyNotes`, which returns null when nothing would change
   * so a click on the colour a note already has costs the class no broadcast.
   */
  const chooseStickyColor = useCallback((color: StickyNoteColor) => {
    setStickyColor(color);
    window.localStorage.setItem(STICKY_NOTE_COLOR_STORAGE_KEY, color);

    const scene = apiRef.current;
    if (!scene) return;
    if (!canEditRef.current) return;

    const appState = scene.getAppState();
    const next = recolourSelectedStickyNotes(
      scene.getSceneElementsIncludingDeleted(),
      appState.selectedElementIds,
      color,
      nextVersionNonce,
    );
    if (!next) return;

    scene.updateScene({
      elements: next,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }, []);

  /**
   * The shortcut. Bound on `document` so it works wherever the focus is, and
   * gated by `shouldCreateStickyNote`, which is what stops a note appearing for
   * every `n` a student types inside another note.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const appState = apiRef.current?.getAppState();
      // Null until the canvas exists, which the guard treats as "do not act":
      // without it there is no way to know whether a note is being typed into.
      const editing = appState
        ? {
            editingTextElement: appState.editingTextElement,
            editingFrame: appState.editingFrame,
            editingLinearElement: appState.editingLinearElement,
            openDialog: appState.openDialog,
          }
        : null;

      if (
        !shouldCreateStickyNote(event, {
          canWrite: authorityRef.current.canWrite,
          editing,
        })
      ) {
        return;
      }

      event.preventDefault();
      createStickyNote();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [createStickyNote]);

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
  canEditRef.current = !readOnly;

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
        tools={
          <>
            <StickyNoteTool
              color={stickyColor}
              onColorChange={chooseStickyColor}
              onCreate={createStickyNote}
              // The live authority, plus the local "your last write was refused"
              // latch that already puts the whole canvas in view mode.
              disabled={readOnly}
            />
            <IconTool
              catalog={iconCatalog}
              onSelect={createIcon}
              disabled={readOnly}
            />
          </>
        }
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
          <div className="excalidraw-host" ref={hostRef}>
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
