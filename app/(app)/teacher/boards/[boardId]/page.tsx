import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/status-badge";
import { requireTeacher } from "@/lib/auth/current-user";
import { listUsers } from "@/lib/auth/users";
import {
  getBoardById,
  listBoardMembers,
} from "@/lib/boards/queries";
import { getBoardParticipation } from "@/lib/participation/queries";
import { db } from "@/lib/db";
import { boardStatus } from "@/lib/db/schema";
import {
  addBoardMemberAction,
  removeBoardMemberAction,
  setBoardStatusAction,
} from "../../actions";

export const dynamic = "force-dynamic";

function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export default async function ManageBoardPage({
  params,
}: {
  params: Promise<{ boardId: string }>;
}) {
  await requireTeacher();
  const { boardId } = await params;

  const board = await getBoardById(db, boardId);
  if (!board) notFound();

  const [members, allUsers, participation] = await Promise.all([
    listBoardMembers(db, boardId),
    listUsers(db),
    getBoardParticipation(db, boardId),
  ]);

  const memberIds = new Set(members.map((member) => member.id));
  const candidates = allUsers.filter((user) => !memberIds.has(user.id));

  return (
    <main className="container">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{board.title}</h1>
        <StatusBadge status={board.status} />
      </div>
      <p className="muted">
        <Link href="/teacher">Back to the panel</Link> ·{" "}
        <Link href={`/boards/${board.id}`}>Open the board</Link>
      </p>

      <div className="card">
        <h2>Status</h2>
        <p className="muted">
          Status is enforced on the server. Freezing a board blocks every write,
          including the teacher&apos;s; read only leaves students able to look
          but not edit.
        </p>
        <div className="row">
          {boardStatus.enumValues.map((status) => (
            <form key={status} action={setBoardStatusAction}>
              <input type="hidden" name="boardId" value={board.id} />
              <input type="hidden" name="status" value={status} />
              <button
                type="submit"
                className={status === board.status ? "primary" : ""}
                disabled={status === board.status}
              >
                {status}
              </button>
            </form>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Members ({members.length})</h2>
        {members.length === 0 ? (
          <p className="muted">Nobody has been assigned yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id}>
                  <td>{member.displayName}</td>
                  <td className="muted">{member.email}</td>
                  <td>{member.role}</td>
                  <td>
                    <form action={removeBoardMemberAction}>
                      <input type="hidden" name="boardId" value={board.id} />
                      <input type="hidden" name="userId" value={member.id} />
                      <button type="submit">Remove</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Assign a student</h2>
        {candidates.length === 0 ? (
          <p className="muted">Every account is already a member.</p>
        ) : (
          <form action={addBoardMemberAction} className="row">
            <input type="hidden" name="boardId" value={board.id} />
            <select name="userId" defaultValue={candidates[0]!.id}>
              {candidates.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName} ({user.email})
                </option>
              ))}
            </select>
            <button className="primary" type="submit">
              Add member
            </button>
          </form>
        )}
      </div>

      <div className="card">
        <h2>Participation</h2>
        <p className="muted">
          Derived from the board session log written by the realtime server
          (Phase B). Empty until the websocket server is connected.
        </p>
        {participation.length === 0 ? (
          <p className="muted">No sessions recorded yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Participant</th>
                <th>Sessions</th>
                <th>Time</th>
                <th>Edits</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {participation.map((row) => (
                <tr key={row.userId}>
                  <td>{row.displayName}</td>
                  <td>{row.sessionCount}</td>
                  <td>{formatDuration(row.totalSeconds)}</td>
                  <td>{row.totalEdits}</td>
                  <td className="muted">
                    {row.lastSeenAt.toISOString().slice(0, 16).replace("T", " ")}
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
