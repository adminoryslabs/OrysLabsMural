import Link from "next/link";
import { logoutAction } from "@/app/login/actions";
import { LogoutIcon } from "@/components/icons";
import { requireUser } from "@/lib/auth/current-user";
import { NavLinks, type NavLink } from "./nav-links";

export const dynamic = "force-dynamic";

/**
 * Role decides the navigation, and every destination here is a route that
 * exists: a link that 404s in front of a class is worse than a missing one.
 */
function navigationFor(role: "teacher" | "student"): NavLink[] {
  if (role === "teacher") {
    return [
      { href: "/teacher", label: "Boards", match: "/teacher" },
      {
        href: "/teacher/classrooms",
        label: "Classrooms",
        match: "/teacher/classrooms",
      },
      { href: "/teacher/users", label: "Students", match: "/teacher/users" },
      { href: "/participation", label: "Participation", match: "/participation" },
    ];
  }
  return [
    { href: "/boards", label: "Boards", match: "/boards" },
    { href: "/participation", label: "Participation", match: "/participation" },
  ];
}

export default async function AuthenticatedLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireUser();

  return (
    <div className="app-shell">
      <header className="app-nav">
        <Link className="app-nav-brand" href="/">
          <span className="brand-mark" aria-hidden="true" />
          <span className="wordmark">OrysLabs Mural</span>
        </Link>

        <NavLinks links={navigationFor(user.role)} />

        <div className="app-nav-user">
          <span className="app-nav-name">{user.displayName}</span>
          <form action={logoutAction}>
            <button className="btn-icon" type="submit" title="Log out">
              <LogoutIcon size={19} />
              <span className="sr-only">Log out</span>
            </button>
          </form>
        </div>
      </header>
      {children}
    </div>
  );
}
