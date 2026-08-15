import type { BoardStatus } from "@/lib/db/schema";

/**
 * ============================================================================
 * PHASE B REPLACES THIS COMPONENT.
 * ============================================================================
 *
 * Phase B swaps this for the Excalidraw canvas wired to Yjs. The props below
 * are the contract this page already provides:
 *
 *   boardId   - Yjs room name.
 *   canWrite  - server-computed (getBoardAccess). Render the canvas read-only
 *               when false, but never rely on it for enforcement: the
 *               websocket server re-checks board status on its own.
 *   status    - current board status, for the banner.
 *
 * The websocket endpoint is exposed to the client as NEXT_PUBLIC_YJS_URL.
 */
export function BoardCanvasPlaceholder({
  boardId,
  canWrite,
  status,
}: {
  boardId: string;
  canWrite: boolean;
  status: BoardStatus;
}) {
  return (
    <div className="board-placeholder">
      <strong>Canvas placeholder</strong>
      <p className="muted">
        The Excalidraw + Yjs canvas is delivered in Phase B. This block marks
        exactly where it mounts.
      </p>
      <p className="muted">
        Board id (Yjs room): <code>{boardId}</code>
      </p>
      <p className="muted">
        Server-side verdict: status <code>{status}</code>, write access{" "}
        <code>{String(canWrite)}</code>.
      </p>
    </div>
  );
}
