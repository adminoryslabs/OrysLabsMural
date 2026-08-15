"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavLink {
  href: string;
  label: string;
  /** Marked active when the path equals this or starts with it plus a slash. */
  match: string;
}

/**
 * The navigation is role-dependent and its links are built on the server; this
 * component only decides which one is current, which needs the pathname.
 */
export function NavLinks({ links }: { links: readonly NavLink[] }) {
  const pathname = usePathname();

  return (
    <nav className="app-nav-links">
      {links.map((link) => {
        const active =
          pathname === link.match || pathname.startsWith(`${link.match}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={
              active ? "app-nav-link app-nav-link-active" : "app-nav-link"
            }
            aria-current={active ? "page" : undefined}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
