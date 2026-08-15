import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import { listBoardsForTeacher } from "@/lib/boards/queries";
import { db } from "@/lib/db";
import { getUserParticipation } from "@/lib/participation/queries";

export const dynamic = "force-dynamic";

function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function formatMoment(value: Date): string {
  return value.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * The navigation promises a Participation destination, so it has to lead
 * somewhere true rather than to a placeholder. Everyone sees their own record,
 * derived from `board_sessions`; a teacher additionally gets the way in to the
 * per-board breakdown that already exists on each board's admin page.
 */
export default async function ParticipationPage() {
  const user = await requireUser();
  const rows = await getUserParticipation(db, user.id);
  const boards =
    user.role === "teacher" ? await listBoardsForTeacher(db) : [];

  return (
    <main className="app-main">
      <div className="container">
        <div className="page-head">
          <div>
            <h1>Participation</h1>
            <p className="page-subline">
              Time and edits are counted from every websocket connection, so a
              tab that dies stops counting at its last heartbeat.
            </p>
          </div>
        </div>

        <div className="card">
          <h2>Your boards</h2>
          {rows.length === 0 ? (
            <p className="muted">
              Nothing recorded yet. Open a board and your time will appear here.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Board</th>
                  <th>Sessions</th>
                  <th>Time</th>
                  <th>Edits</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.boardId}>
                    <td>
                      <Link href={`/boards/${row.boardId}`}>
                        {row.boardTitle}
                      </Link>
                    </td>
                    <td>{row.sessionCount}</td>
                    <td>{formatDuration(row.totalSeconds)}</td>
                    <td>{row.totalEdits}</td>
                    <td className="muted">{formatMoment(row.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {user.role === "teacher" ? (
          <div className="card">
            <h2>Per board</h2>
            {boards.length === 0 ? (
              <p className="muted">No boards yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Board</th>
                    <th>Members</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {boards.map((board) => (
                    <tr key={board.id}>
                      <td>{board.title}</td>
                      <td>{board.memberCount}</td>
                      <td>
                        <Link href={`/teacher/boards/${board.id}`}>
                          Who took part
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : null}
      </div>
    </main>
  );
}
