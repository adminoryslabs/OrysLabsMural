import Link from "next/link";
import { requireTeacher } from "@/lib/auth/current-user";
import { listClassrooms } from "@/lib/classrooms/queries";
import { db } from "@/lib/db";
import { pluralize } from "@/lib/format";
import { CreateClassroomForm } from "./create-classroom-form";

export const dynamic = "force-dynamic";

/**
 * The cohorts. This is the assignment screen now: a student put in a classroom
 * reaches every board of that classroom at once, and stops reaching all of them
 * at once when they leave it.
 */
export default async function ClassroomsPage() {
  await requireTeacher();
  const classrooms = await listClassrooms(db);

  return (
    <main className="app-main">
      <div className="container">
        <div className="page-head">
          <div>
            <h1>Classrooms</h1>
            <p className="page-subline">
              {pluralize(classrooms.length, "classroom")} · a classroom is who a
              board is taught to
            </p>
          </div>
        </div>

        <div className="card">
          <h2>New classroom</h2>
          <CreateClassroomForm />
        </div>

        <div className="card">
          <h2>Classrooms ({classrooms.length})</h2>
          {classrooms.length === 0 ? (
            <p className="muted">
              No classrooms yet. Create one, put the students in it, then assign
              your boards to it from each board&apos;s page.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Students</th>
                  <th>Boards</th>
                  <th>Created by</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {classrooms.map((classroom) => (
                  <tr key={classroom.id}>
                    <td>
                      <Link href={`/teacher/classrooms/${classroom.id}`}>
                        {classroom.name}
                      </Link>
                    </td>
                    <td>{classroom.memberCount}</td>
                    <td>{classroom.boardCount}</td>
                    <td className="muted">{classroom.ownerName}</td>
                    <td>
                      <Link href={`/teacher/classrooms/${classroom.id}`}>
                        Manage
                      </Link>
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
