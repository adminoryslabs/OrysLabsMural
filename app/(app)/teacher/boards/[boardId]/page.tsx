import Link from "next/link";
import { notFound } from "next/navigation";
import { BatchMembersForm } from "@/components/batch-members-form";
import { StatusBadge } from "@/components/status-badge";
import { requireTeacher } from "@/lib/auth/current-user";
import { listUsers } from "@/lib/auth/users";
import {
  getBoardById,
  listBoardMembers,
  listBoardRoster,
} from "@/lib/boards/queries";
import { listClassrooms } from "@/lib/classrooms/queries";
import { getBoardParticipation } from "@/lib/participation/queries";
import { db } from "@/lib/db";
import { boardStatus } from "@/lib/db/schema";
import {
  addBoardMembersAction,
  deleteBoardAction,
  removeBoardMemberAction,
  removeBoardMembersAction,
  setBoardStatusAction,
} from "../../actions";
import { BoardClassroomForm } from "./board-classroom-form";

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
  const teacher = await requireTeacher();
  const { boardId } = await params;

  const board = await getBoardById(db, boardId);
  if (!board) notFound();

  const [members, roster, allUsers, classroomList, participation] =
    await Promise.all([
      listBoardMembers(db, boardId),
      listBoardRoster(db, boardId),
      listUsers(db),
      listClassrooms(db),
      getBoardParticipation(db, boardId),
    ]);

  const classroom = classroomList.find((row) => row.id === board.classroomId);
  const memberIds = new Set(members.map((member) => member.id));
  const candidates = allUsers.filter((user) => !memberIds.has(user.id));
  const viaClassroom = roster.filter((person) => !person.isExplicitMember);

  return (
    <main className="app-main">
      <div className="container">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{board.title}</h1>
        <StatusBadge status={board.status} />
      </div>
      <p className="muted">
        <Link href="/teacher">Back to the panel</Link> ·{" "}
        <Link href={`/boards/${board.id}`}>Open the board</Link>
        {classroom ? (
          <>
            {" · "}
            <Link href={`/teacher/classrooms/${classroom.id}`}>
              {classroom.name}
            </Link>
          </>
        ) : null}
      </p>

      <div className="card">
        <h2>Status</h2>
        <p className="muted">
          Status is enforced on the server. Freezing a board blocks every write,
          including the teacher&apos;s; read only leaves students able to look
          but not edit. Status outranks membership by every path: belonging to
          the classroom buys nothing on a frozen board.
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
        <h2>Classroom</h2>
        <p className="muted">
          The classroom is who this board is taught to. Everyone in it reaches
          this board immediately, and stops reaching it the moment they leave the
          classroom — the roster is read on every request, never copied here.
        </p>
        <BoardClassroomForm
          boardId={board.id}
          classroomId={board.classroomId}
          classrooms={classroomList.map((row) => ({
            id: row.id,
            name: row.name,
            memberCount: row.memberCount,
          }))}
        />
        {classroomList.length === 0 ? (
          <p className="muted">
            No classrooms yet.{" "}
            <Link href="/teacher/classrooms">Create the first one</Link>.
          </p>
        ) : null}
      </div>

      {board.ownerId === teacher.id ? (
        <div className="card">
          <h2>Delete this board</h2>
          <p className="muted">
            Deleting removes the document, the membership and the participation
            log. Only the teacher who owns the board can do it.
          </p>
          <form action={deleteBoardAction}>
            <input type="hidden" name="boardId" value={board.id} />
            <button className="danger" type="submit">
              Delete board
            </button>
          </form>
        </div>
      ) : null}

      <div className="card">
        <h2>Who can open this board ({roster.length})</h2>
        <p className="muted">
          {classroom
            ? `${viaClassroom.length} through the classroom “${classroom.name}”, ${members.length} listed individually below.`
            : "This board has no classroom, so only the people listed individually below can open it."}
        </p>
        {roster.length === 0 ? (
          <p className="muted">Nobody can open this board yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Access</th>
              </tr>
            </thead>
            <tbody>
              {roster.map((person) => (
                <tr key={person.id}>
                  <td>{person.displayName}</td>
                  <td className="muted">{person.email}</td>
                  <td>{person.role}</td>
                  <td className="muted">
                    {person.isExplicitMember
                      ? "Individual exception"
                      : "Classroom"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Individual exceptions ({members.length})</h2>
        <p className="muted">
          The escape hatch, not the normal way to assign a class: a teaching
          assistant or a guest who is not in the classroom. It only ever ADDS
          access — removing somebody here does not take away what their
          classroom gives them.
        </p>

        <h3>Add an exception ({candidates.length} available)</h3>
        <BatchMembersForm
          scopeId={board.id}
          scopeField="boardId"
          people={candidates}
          action={addBoardMembersAction}
          submitLabel="Add to the board"
          emptyLabel="Every account is already listed here."
          pasteHint="Or paste emails, separated by commas or new lines:"
        />

        {members.length > 0 ? (
          <>
            <h3>Remove an exception</h3>
            <BatchMembersForm
              scopeId={board.id}
              scopeField="boardId"
              people={members}
              action={removeBoardMembersAction}
              submitLabel="Remove from the board"
              emptyLabel="No individual exceptions."
              pasteHint="Or paste the emails to remove:"
            />
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
          </>
        ) : (
          <p className="muted">No individual exceptions on this board.</p>
        )}
      </div>

      <div className="card">
        <h2>Participation</h2>
        <p className="muted">
          Derived from the board session log written by the realtime server.
          Empty until the websocket server is connected.
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
      </div>
    </main>
  );
}
