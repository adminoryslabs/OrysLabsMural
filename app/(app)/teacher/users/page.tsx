import { requireTeacher } from "@/lib/auth/current-user";
import { listUsers } from "@/lib/auth/users";
import { db } from "@/lib/db";
import { CreateUserForm } from "./create-user-form";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  await requireTeacher();
  const users = await listUsers(db);

  return (
    <main className="app-main">
      <div className="container">
      <h1>Students</h1>
      <p className="muted">
        There is no public registration. Accounts are created here or by the
        seed script.
      </p>

      <div className="card">
        <h2>New account</h2>
        <CreateUserForm />
      </div>

      <div className="card">
        <h2>Accounts ({users.length})</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.displayName}</td>
                <td className="muted">{user.email}</td>
                <td>{user.role}</td>
                <td className="muted">
                  {user.createdAt.toISOString().slice(0, 10)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>
    </main>
  );
}
