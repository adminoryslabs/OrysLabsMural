import type { BoardCardData } from "@/components/board-card";
import { requireTeacher } from "@/lib/auth/current-user";
import { listBoardsForTeacher } from "@/lib/boards/queries";
import { db } from "@/lib/db";
import { formatUpdated, pluralize } from "@/lib/format";
import { getOnlinePresenceByBoard } from "@/lib/participation/queries";
import { BoardsDashboard } from "./boards-dashboard";

export const dynamic = "force-dynamic";

export default async function TeacherPanelPage() {
  await requireTeacher();

  const [boards, presence] = await Promise.all([
    listBoardsForTeacher(db),
    getOnlinePresenceByBoard(db),
  ]);

  const now = new Date();
  const cards: BoardCardData[] = boards.map((board) => ({
    id: board.id,
    title: board.title,
    href: `/boards/${board.id}`,
    manageHref: `/teacher/boards/${board.id}`,
    members: pluralize(board.memberCount, "member"),
    updated: formatUpdated(board.updatedAt, now),
    status: board.status,
    online: presence.get(board.id) ?? [],
  }));

  // Counted across boards, so a student on two boards is one connected student.
  const connected = new Set(
    [...presence.values()].flat().flatMap((person) =>
      person.role === "student" ? [person.userId] : [],
    ),
  ).size;

  return (
    <main className="app-main">
      <div className="container">
        <BoardsDashboard
          boards={cards}
          subline={`${pluralize(cards.length, "board")} · ${pluralize(
            connected,
            "student",
          )} connected`}
        />
      </div>
    </main>
  );
}
