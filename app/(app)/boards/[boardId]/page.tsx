import { notFound } from "next/navigation";
import { BoardCanvas } from "@/components/board-canvas";
import { requireUser } from "@/lib/auth/current-user";
import { getBoardAccess } from "@/lib/boards/queries";
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

  return (
    <main className="container board-page">
      <h1>{access.board.title}</h1>

      {/*
        The status and the "read only" notice deliberately live INSIDE the
        canvas, next to the live connection indicator. Rendering them here as
        well would freeze them at page-render time, which is exactly the stale
        state the collaboration server now pushes past.
      */}
      <BoardCanvas
        boardId={access.board.id}
        boardTitle={access.board.title}
        canWrite={access.canWrite}
        status={access.board.status}
        user={{ id: user.id, displayName: user.displayName }}
        serverUrl={yjsServerUrl()}
      />
    </main>
  );
}
