"use client";

import { Suspense, lazy, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowBackIcon } from "./icons";
import type { BoardCanvasProps } from "./board-canvas-scene";

/**
 * The shell shown while the Excalidraw bundle and the socket are still coming
 * up. It is deliberately the real chrome — back button, board title — rather
 * than a blank page, so opening a board in front of a class never looks broken.
 *
 * It carries no state control and no roster: both would be lying until the
 * collaboration server has said anything.
 */
function BoardShell({
  boardTitle,
  backHref,
}: {
  boardTitle: string;
  backHref: string;
}) {
  return (
    <div className="board-screen">
      <div className="board-topbar">
        <Link className="btn-icon board-topbar-back" href={backHref}>
          <ArrowBackIcon size={19} />
          <span className="sr-only">Back to the boards</span>
        </Link>
        <p className="board-topbar-title">{boardTitle}</p>
      </div>
      <div className="board-body">
        <div className="board-canvas-surface">
          <div className="board-canvas-loading">
            <p className="muted">Loading the whiteboard…</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Excalidraw touches `window` at module scope, so it can never be rendered on
 * the server. `lazy` plus the mounted guard below is `ssr: false` written by
 * hand — and unlike `next/dynamic`'s own `loading`, a Suspense fallback can be
 * given the board's title.
 */
const BoardCanvasScene = lazy(() =>
  import("./board-canvas-scene").then((mod) => ({
    default: mod.BoardCanvasScene,
  })),
);

export function BoardCanvas(props: BoardCanvasProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const shell = (
    <BoardShell
      boardTitle={props.boardTitle}
      backHref={props.canAdminister ? "/teacher" : "/boards"}
    />
  );

  if (!mounted) return shell;

  return (
    <Suspense fallback={shell}>
      <BoardCanvasScene {...props} />
    </Suspense>
  );
}

export type { BoardCanvasProps };
