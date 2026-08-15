import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import { listBoardsForUser } from "@/lib/boards/queries";
import { db } from "@/lib/db";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

export default async function MyBoardsPage() {
  const user = await requireUser();
  const boards = await listBoardsForUser(db, user.id);

  return (
    <main className="app-main container">
      <h1>My boards</h1>

      {boards.length === 0 ? (
        <div className="card">
          <p className="muted">
            You have not been assigned to any board yet. Your instructor will
            add you to one.
          </p>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Board</th>
                <th>Status</th>
                <th>Last updated</th>
              </tr>
            </thead>
            <tbody>
              {boards.map((board) => (
                <tr key={board.id}>
                  <td>
                    <Link href={`/boards/${board.id}`}>{board.title}</Link>
                  </td>
                  <td>
                    <StatusBadge status={board.status} />
                  </td>
                  <td className="muted">
                    {board.updatedAt.toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
