import Link from "next/link";
import { logoutAction } from "@/app/login/actions";
import { requireUser } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireUser();

  return (
    <>
      <header className="app-header">
        <nav>
          <Link className="brand" href="/">
            OrysLabs Mural
          </Link>
          <Link href="/boards">My boards</Link>
          {user.role === "teacher" ? (
            <>
              <Link href="/teacher">Teacher panel</Link>
              <Link href="/teacher/users">Users</Link>
            </>
          ) : null}
        </nav>
        <div className="row">
          <span className="muted">
            {user.displayName} ({user.role})
          </span>
          <form action={logoutAction}>
            <button type="submit">Log out</button>
          </form>
        </div>
      </header>
      {children}
    </>
  );
}
