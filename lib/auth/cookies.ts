import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "./session-cookie";

// The name itself lives in the framework-free module so the Yjs websocket
// server can share it without dragging `next/headers` into a plain Node process.
export { SESSION_COOKIE_NAME };

function secureCookies(): boolean {
  if (process.env.COOKIE_SECURE) {
    return process.env.COOKIE_SECURE === "true";
  }
  return process.env.NODE_ENV === "production";
}

/**
 * httpOnly so no script can read it, sameSite=lax so it survives a normal
 * top-level navigation but not a cross-site form post, secure in production.
 */
export async function setSessionCookie(
  token: string,
  expiresAt: Date,
): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value ?? null;
}
