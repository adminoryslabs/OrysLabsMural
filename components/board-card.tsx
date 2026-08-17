import Link from "next/link";
import type { BoardStatus } from "@/lib/db/schema";
import { PresenceRow, type PresencePerson } from "./avatar";
import { StatusBadge, StatusDot } from "./status-badge";

export interface BoardCardData {
  id: string;
  title: string;
  /** Where the title goes: the board itself. */
  href: string;
  /** Pre-formatted on the server, e.g. "7 members". Omitted for students. */
  members?: string;
  /**
   * The cohort this board is taught to, or null when it is unassigned. It is
   * shown because it is the answer to "who can open this", which on a classroom
   * board is no longer the member list.
   */
  classroom?: string | null;
  /** Pre-formatted on the server, e.g. "Updated 18:02". */
  updated: string;
  /**
   * Admin page for the board, when the viewer may administer it. The member
   * count is the link, which is where a teacher already looks for the roster —
   * cheaper than another control in the card.
   */
  manageHref?: string;
  status: BoardStatus;
  online: PresencePerson[];
}

function Meta({ board }: { board: BoardCardData }) {
  return (
    <>
      {board.classroom ? (
        <>
          <span className="board-card-classroom">{board.classroom}</span>
          {" · "}
        </>
      ) : null}
      {board.members ? (
        <>
          {board.manageHref ? (
            <Link href={board.manageHref}>{board.members}</Link>
          ) : (
            board.members
          )}
          {" · "}
        </>
      ) : null}
      {board.updated}
    </>
  );
}

/**
 * One board in the grid. The thumbnail strip is the dotted empty state; when a
 * rendered snapshot exists it belongs here instead of the dot grid.
 *
 * `action` is the state control, passed in rather than assumed: a student sees
 * the same card without one.
 */
export function BoardCard({
  board,
  action,
}: {
  board: BoardCardData;
  action?: React.ReactNode;
}) {
  return (
    <article className="board-card">
      <div
        className={
          board.status === "frozen"
            ? "board-card-thumb board-card-thumb-frozen"
            : "board-card-thumb"
        }
      >
        <StatusDot status={board.status} />
      </div>

      <div className="board-card-body">
        <Link className="board-card-title" href={board.href}>
          {board.title}
        </Link>
        <p className="board-card-meta">
          <Meta board={board} />
        </p>
        <div className="board-card-presence">
          <PresenceRow people={board.online} onSurface />
        </div>
      </div>

      <div className="board-card-foot">
        <StatusBadge status={board.status} />
        {action}
      </div>
    </article>
  );
}

/** The same board as a list row. */
export function BoardRow({
  board,
  action,
}: {
  board: BoardCardData;
  action?: React.ReactNode;
}) {
  return (
    <div className="board-row">
      <div style={{ minWidth: 0 }}>
        <Link className="board-row-title" href={board.href}>
          {board.title}
        </Link>
        <p className="board-row-meta">
          <Meta board={board} />
        </p>
      </div>

      <PresenceRow people={board.online} />
      <StatusBadge status={board.status} />
      <div className="board-row-action">{action}</div>
    </div>
  );
}
