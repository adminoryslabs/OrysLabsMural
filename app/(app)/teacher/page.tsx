import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { requireTeacher } from "@/lib/auth/current-user";
import { listBoardsForTeacher } from "@/lib/boards/queries";
import { db } from "@/lib/db";
import { boardStatus } from "@/lib/db/schema";
import { deleteBoardAction, setBoardStatusAction } from "./actions";
import { CreateBoardForm } from "./create-board-form";

export const dynamic = "force-dynamic";

export default async function TeacherPanelPage() {
  const teacher = await requireTeacher();
  const boards = await listBoardsForTeacher(db);

  return (
    <main className="app-main container">
      <h1>Teacher panel</h1>

      <div className="card">
        <h2>New board</h2>
        <CreateBoardForm />
      </div>

      <div className="card">
        <h2>Boards</h2>
        {boards.length === 0 ? (
          <p className="muted">No boards yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Owner</th>
                <th>Members</th>
                <th>Status</th>
                <th>Change status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {boards.map((board) => (
                <tr key={board.id}>
                  <td>
                    <Link href={`/teacher/boards/${board.id}`}>
                      {board.title}
                    </Link>
                  </td>
                  <td className="muted">{board.ownerName}</td>
                  <td>{board.memberCount}</td>
                  <td>
                    <StatusBadge status={board.status} />
                  </td>
                  <td>
                    <div className="row">
                      {boardStatus.enumValues
                        .filter((status) => status !== board.status)
                        .map((status) => (
                          <form
                            key={status}
                            action={setBoardStatusAction}
                            className="inline-form"
                          >
                            <input
                              type="hidden"
                              name="boardId"
                              value={board.id}
                            />
                            <input type="hidden" name="status" value={status} />
                            <button type="submit">{status}</button>
                          </form>
                        ))}
                    </div>
                  </td>
                  <td>
                    {board.ownerId === teacher.id ? (
                      <form action={deleteBoardAction}>
                        <input type="hidden" name="boardId" value={board.id} />
                        <button className="danger" type="submit">
                          Delete
                        </button>
                      </form>
                    ) : (
                      <span className="muted">Owner only</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
