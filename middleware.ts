import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE_NAME = "mural_session";

/**
 * Cheap gate only. Middleware runs on the edge runtime, where the database and
 * argon2 are not available, so it can do no more than check that a session
 * cookie is present and bounce anonymous traffic to the login form.
 *
 * Real authentication and every role check happen server-side in
 * `requireUser` / `requireTeacher`. Never treat "passed the middleware" as
 * "authenticated".
 */
export function middleware(request: NextRequest) {
  const hasCookie = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  const { pathname, search } = request.nextUrl;

  if (!hasCookie) {
    const loginUrl = new URL("/login", request.url);
    if (pathname !== "/") {
      loginUrl.searchParams.set("next", `${pathname}${search}`);
    }
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except the login page, the API, static assets and the health check.
  matcher: [
    "/((?!login|api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
