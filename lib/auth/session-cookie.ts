/**
 * Runtime-agnostic half of the session cookie.
 *
 * `lib/auth/cookies.ts` imports `next/headers` and therefore only runs inside
 * Next.js. The Yjs websocket server is a plain Node process and must read the
 * very same cookie from a raw `Cookie` header, so the name and the parser live
 * here, with no framework import, and both runtimes share one definition.
 */

export const SESSION_COOKIE_NAME = "mural_session";

/**
 * Minimal RFC 6265 cookie-header parser. Deliberately tolerant of the shapes a
 * browser actually sends (`a=1; b=2`) and of values containing `=`.
 * The first occurrence of a name wins, which matches how browsers resolve
 * duplicate cookies sent for overlapping paths.
 */
export function parseCookieHeader(
  header: string | null | undefined,
): Record<string, string> {
  const jar: Record<string, string> = {};
  if (!header) return jar;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;

    const name = part.slice(0, separator).trim();
    if (name.length === 0 || name in jar) continue;

    const rawValue = part.slice(separator + 1).trim();
    const value =
      rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue;

    try {
      jar[name] = decodeURIComponent(value);
    } catch {
      // A malformed percent-escape must not crash the handshake; the token
      // simply will not match any stored session hash.
      jar[name] = value;
    }
  }

  return jar;
}

/** Extracts the session token from a raw `Cookie` header, or null. */
export function readSessionTokenFromCookieHeader(
  header: string | null | undefined,
): string | null {
  const value = parseCookieHeader(header)[SESSION_COOKIE_NAME];
  return value && value.length > 0 ? value : null;
}
