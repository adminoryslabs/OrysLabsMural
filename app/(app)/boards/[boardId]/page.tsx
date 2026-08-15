import { notFound } from "next/navigation";
import { BoardCanvasPlaceholder } from "@/components/board-canvas-placeholder";
import { StatusBadge } from "@/components/status-badge";
import { requireUser } from "@/lib/auth/current-user";
import { getBoardAccess } from "@/lib/boards/queries";
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

  return (
    <main className="container">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{access.board.title}</h1>
        <StatusBadge status={access.board.status} />
      </div>

      {!access.canWrite ? (
        <p className="muted">
          {access.board.status === "frozen"
            ? "This board is frozen. Nobody can edit it right now."
            : "This board is read only for you."}
        </p>
      ) : null}

      <BoardCanvasPlaceholder
        boardId={access.board.id}
        canWrite={access.canWrite}
        status={access.board.status}
      />
    </main>
  );
}
