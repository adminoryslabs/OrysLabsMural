import Link from "next/link";
import { notFound } from "next/navigation";
import { BatchMembersForm } from "@/components/batch-members-form";
import { StatusBadge } from "@/components/status-badge";
import { requireTeacher } from "@/lib/auth/current-user";
import { listUsers } from "@/lib/auth/users";
import { listBoardsInClassroom } from "@/lib/boards/queries";
import { canDeleteClassroom } from "@/lib/classrooms/authority";
import {
  getClassroomById,
  listClassroomMembers,
} from "@/lib/classrooms/queries";
import { db } from "@/lib/db";
import {
  addClassroomMembersAction,
  removeClassroomMembersAction,
} from "../../classroom-actions";
import { DeleteClassroomForm } from "./delete-classroom-form";
import { RenameClassroomForm } from "./rename-classroom-form";

export const dynamic = "force-dynamic";

export default async function ManageClassroomPage({
  params,
}: {
  params: Promise<{ classroomId: string }>;
}) {
  const teacher = await requireTeacher();
  const { classroomId } = await params;

  const classroom = await getClassroomById(db, classroomId);
  if (!classroom) notFound();

  const [members, allUsers, boards] = await Promise.all([
    listClassroomMembers(db, classroomId),
    listUsers(db),
    listBoardsInClassroom(db, classroomId),
  ]);

  const memberIds = new Set(members.map((member) => member.id));
  const candidates = allUsers.filter((user) => !memberIds.has(user.id));

  return (
    <main className="app-main">
      <div className="container">
        <h1>{classroom.name}</h1>
        <p className="muted">
          <Link href="/teacher/classrooms">Back to classrooms</Link> ·{" "}
          {members.length} students · {boards.length} boards
        </p>

        <div className="card">
          <h2>Name</h2>
          <RenameClassroomForm
            classroomId={classroom.id}
            name={classroom.name}
          />
        </div>

        <div className="card">
          <h2>Add students ({candidates.length} available)</h2>
          <p className="muted">
            Everyone added here reaches every board of this classroom
            immediately — there is nothing to copy into the boards afterwards.
            Tick as many as you like, or paste the roster; one unknown address
            never costs the rest of the batch.
          </p>
          <BatchMembersForm
            scopeId={classroom.id}
            scopeField="classroomId"
            people={candidates}
            action={addClassroomMembersAction}
            submitLabel="Add to the classroom"
            emptyLabel="Every account is already in this classroom."
            pasteHint="Or paste emails, separated by commas or new lines:"
          />
        </div>

        <div className="card">
          <h2>Students ({members.length})</h2>
          <p className="muted">
            Removing a student here revokes every board of this classroom for
            them at once. They keep access only to boards where they are listed
            as an individual exception.
          </p>
          {members.length === 0 ? (
            <p className="muted">Nobody is in this classroom yet.</p>
          ) : (
            <>
              <BatchMembersForm
                scopeId={classroom.id}
                scopeField="classroomId"
                people={members}
                action={removeClassroomMembersAction}
                submitLabel="Remove from the classroom"
                emptyLabel="Nobody is in this classroom yet."
                pasteHint="Or paste the emails to remove:"
              />
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => (
                    <tr key={member.id}>
                      <td>{member.displayName}</td>
                      <td className="muted">{member.email}</td>
                      <td>{member.role}</td>
                      <td className="muted">
                        {member.joinedAt.toISOString().slice(0, 10)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>

        <div className="card">
          <h2>Boards ({boards.length})</h2>
          <p className="muted">
            To teach a board to this classroom, open <Link href="/teacher">Boards</Link>{" "}
            and use <strong>Manage</strong> on the board you want.
          </p>
          {boards.length === 0 ? (
            <p className="muted">
              No boards are taught to this classroom yet.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Board</th>
                  <th>Status</th>
                  <th />
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
                    <td>
                      <Link href={`/teacher/boards/${board.id}`}>Manage</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {canDeleteClassroom({ classroom, user: teacher }) ? (
          <div className="card">
            <h2>Delete this classroom</h2>
            <p className="muted">
              Deleting a classroom does NOT delete its boards. The{" "}
              {boards.length} board{boards.length === 1 ? "" : "s"} above stay,
              detached, holding only their individual exceptions — which means
              the {members.length} student
              {members.length === 1 ? "" : "s"} in this classroom lose access to
              them. Only the teacher who created the classroom can do it.
            </p>
            <DeleteClassroomForm
              classroomId={classroom.id}
              boardCount={boards.length}
            />
          </div>
        ) : null}
      </div>
    </main>
  );
}
