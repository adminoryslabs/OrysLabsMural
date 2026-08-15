"use client";

import { useEffect, useState } from "react";
import { BoardCard, BoardRow, type BoardCardData } from "@/components/board-card";
import { AddIcon, GridViewIcon, ViewListIcon } from "@/components/icons";
import { BoardStateAction } from "./board-state-action";
import { CreateBoardForm } from "./create-board-form";

type DashboardView = "grid" | "list";

const VIEW_STORAGE_KEY = "mural.dashboardView";

/**
 * The teacher's board listing.
 *
 * Only the view preference and the create panel are client state; the boards,
 * their states and who is connected all come from the server on every render.
 * The view is read from localStorage after mount rather than during it, so the
 * server and the first client render agree on the default.
 */
export function BoardsDashboard({
  boards,
  subline,
}: {
  boards: readonly BoardCardData[];
  subline: string;
}) {
  const [view, setView] = useState<DashboardView>("grid");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === "grid" || stored === "list") setView(stored);
  }, []);

  const chooseView = (next: DashboardView) => {
    setView(next);
    window.localStorage.setItem(VIEW_STORAGE_KEY, next);
  };

  const actionFor = (board: BoardCardData) => (
    <BoardStateAction
      boardId={board.id}
      boardTitle={board.title}
      status={board.status}
      onlineCount={board.online.length}
    />
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Boards</h1>
          <p className="page-subline">{subline}</p>
        </div>

        <div className="page-head-actions">
          <div className="view-toggle" role="group" aria-label="Board layout">
            <button
              type="button"
              aria-pressed={view === "grid"}
              onClick={() => chooseView("grid")}
              title="Grid view"
            >
              <GridViewIcon size={19} />
              <span className="sr-only">Grid view</span>
            </button>
            <button
              type="button"
              aria-pressed={view === "list"}
              onClick={() => chooseView("list")}
              title="List view"
            >
              <ViewListIcon size={19} />
              <span className="sr-only">List view</span>
            </button>
          </div>

          <button
            className="btn-solid"
            type="button"
            aria-expanded={creating}
            onClick={() => setCreating((open) => !open)}
          >
            <AddIcon size={18} />
            New board
          </button>
        </div>
      </div>

      {creating ? <CreateBoardForm onDone={() => setCreating(false)} /> : null}

      {boards.length === 0 ? (
        <p className="empty-line">No boards yet. Create the first one.</p>
      ) : view === "grid" ? (
        <div className="board-grid">
          {boards.map((board) => (
            <BoardCard key={board.id} board={board} action={actionFor(board)} />
          ))}
        </div>
      ) : (
        <div className="board-list">
          {boards.map((board) => (
            <BoardRow key={board.id} board={board} action={actionFor(board)} />
          ))}
        </div>
      )}
    </>
  );
}
