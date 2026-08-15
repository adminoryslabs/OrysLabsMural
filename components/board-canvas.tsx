"use client";

import dynamic from "next/dynamic";
import type { BoardCanvasProps } from "./board-canvas-scene";

/**
 * Excalidraw touches `window` at module scope, so it can never be rendered on
 * the server. Loading it through a client-side dynamic import with `ssr: false`
 * is the only way to mount it from an App Router page.
 */
const BoardCanvasScene = dynamic(
  () => import("./board-canvas-scene").then((mod) => mod.BoardCanvasScene),
  {
    ssr: false,
    loading: () => (
      <div className="board-canvas-loading">
        <p className="muted">Loading the whiteboard…</p>
      </div>
    ),
  },
);

export function BoardCanvas(props: BoardCanvasProps) {
  return <BoardCanvasScene {...props} />;
}

export type { BoardCanvasProps };
