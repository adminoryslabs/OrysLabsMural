import { BoardCard, type BoardCardData } from "@/components/board-card";
import { requireUser } from "@/lib/auth/current-user";
import { listBoardsForUser } from "@/lib/boards/queries";
import { db } from "@/lib/db";
import { formatUpdated } from "@/lib/format";
import { getOnlinePresenceByBoard } from "@/lib/participation/queries";

export const dynamic = "force-dynamic";

/**
 * A student's own boards. Same card as the teacher's dashboard, without the
 * state control: changing a board's state is not theirs to do, and rendering a
 * button they cannot use would only invite them to try.
 */
export default async function MyBoardsPage() {
  const user = await requireUser();
  const [boards, presence] = await Promise.all([
    listBoardsForUser(db, user.id),
    getOnlinePresenceByBoard(db),
  ]);

  const now = new Date();
  const cards: BoardCardData[] = boards.map((board) => ({
    id: board.id,
    title: board.title,
    href: `/boards/${board.id}`,
    updated: formatUpdated(board.updatedAt, now),
    status: board.status,
    online: presence.get(board.id) ?? [],
  }));

  return (
    <main className="app-main">
      <div className="container">
        <div className="page-head">
          <div>
            <h1>Boards</h1>
            <p className="page-subline">
              The boards your instructor has put you on.
            </p>
          </div>
        </div>

        {cards.length === 0 ? (
          <p className="empty-line">
            You have not been assigned to any board yet. Your instructor will
            add you to one.
          </p>
        ) : (
          <div className="board-grid">
            {cards.map((board) => (
              <BoardCard key={board.id} board={board} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
