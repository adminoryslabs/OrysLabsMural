import { notFound } from "next/navigation";
import { BoardCanvas } from "@/components/board-canvas";
import { requireUser } from "@/lib/auth/current-user";
import { canAdministerBoard } from "@/lib/boards/authority";
import { getBoardAccess, listBoardRoster } from "@/lib/boards/queries";
import { yjsServerUrl } from "@/lib/collab/config";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function BoardPage({
  params,
}: {
  params: Promise<{ boardId: string }>;
}) {
  const user = await requireUser();
  const { boardId } = await params;

  const access = await getBoardAccess(db, boardId, user.id);
  // A board the user may not view is indistinguishable from one that does not
  // exist, so membership cannot be probed from the outside.
  if (!access || !access.canView) {
    notFound();
  }

  // Everyone who can reach the board, classroom included: the people panel
  // would otherwise tell a cohort of twenty-five that nobody is assigned.
  const members = await listBoardRoster(db, access.board.id);

  return (
    <main className="app-main-fixed">
      {/*
        The status, the state control and the "read only" notice deliberately
        live INSIDE the canvas component, next to the live connection indicator.
        Rendering them here as well would freeze them at page-render time, which
        is exactly the stale state the collaboration server pushes past.
      */}
      <BoardCanvas
        boardId={access.board.id}
        boardTitle={access.board.title}
        canWrite={access.canWrite}
        status={access.board.status}
        canAdminister={canAdministerBoard({
          board: access.board,
          user: { id: user.id, role: access.role },
        })}
        user={{ id: user.id, displayName: user.displayName }}
        members={members.map((member) => ({
          userId: member.id,
          displayName: member.displayName,
        }))}
        serverUrl={yjsServerUrl()}
      />
    </main>
  );
}
