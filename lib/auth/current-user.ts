import { cache } from "react";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { readSessionToken } from "./cookies";
import { validateSessionToken, type SessionValidationResult } from "./session";
import type { PublicUser } from "./users";

/**
 * Resolves the request's cookie to a user. `cache` deduplicates it across every
 * server component of a single render.
 *
 * The middleware only checks that a cookie exists; THIS is where a request is
 * actually authenticated.
 */
export const getCurrentSession = cache(
  async (): Promise<SessionValidationResult> => {
    const token = await readSessionToken();
    if (!token) return { session: null, user: null };
    return validateSessionToken(db, token);
  },
);

export async function getCurrentUser(): Promise<PublicUser | null> {
  return (await getCurrentSession()).user;
}

/** Guard for any authenticated page. Redirects to the login form. */
export async function requireUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}

/**
 * Guard for the teacher panel. The role comes from the database row loaded by
 * the session, never from the request.
 */
export async function requireTeacher(): Promise<PublicUser> {
  const user = await requireUser();
  if (user.role !== "teacher") {
    redirect("/boards");
  }
  return user;
}
