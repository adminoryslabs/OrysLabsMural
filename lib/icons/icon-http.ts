import { validateSessionToken } from "@/lib/auth/session";
import { readSessionTokenFromCookieHeader } from "@/lib/auth/session-cookie";
import { isTeacher } from "@/lib/boards/authority";
import {
  isAllowedImageMimeType,
  maxBoardFileBytes,
  sniffImageMimeType,
} from "@/lib/boards/files";
import type { Database } from "@/lib/db";
import type { UserRole } from "@/lib/db/schema";
import {
  IconNameTakenError,
  getIconByFileId,
  isValidIconName,
  listIconCatalog,
  saveIconCatalogEntry,
} from "@/lib/icons/icons";

/**
 * THE HTTP SIDE OF THE GLOBAL ICON BANK, WITHOUT NEXT.
 *
 * Same shape as `lib/boards/file-http.ts`: plain `Request` -> `Response`
 * functions taking the database explicitly, so the route files under
 * `app/api/icons` stay three-line adapters and the test suite exercises the
 * exact code that ships.
 *
 * There is no board in this picture, so there is no `canView`/`canWrite`
 * distinction — reading the catalog only requires a valid session (any role);
 * adding to it requires a teacher.
 */

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function notFound(): Response {
  return json({ error: "not_found" }, 404);
}

function unauthenticated(): Response {
  return json({ error: "unauthenticated" }, 401);
}

type Authenticated =
  | { ok: true; userId: string; role: UserRole }
  | { ok: false; response: Response };

async function authenticate(
  db: Database,
  request: Request,
): Promise<Authenticated> {
  const token = readSessionTokenFromCookieHeader(request.headers.get("cookie"));
  if (!token) return { ok: false, response: unauthenticated() };

  const { user } = await validateSessionToken(db, token);
  if (!user) return { ok: false, response: unauthenticated() };

  return { ok: true, userId: user.id, role: user.role };
}

/** `GET /api/icons` — the catalog's names and labels, never the bytes. */
export async function handleIconCatalogList(
  db: Database,
  request: Request,
): Promise<Response> {
  const authed = await authenticate(db, request);
  if (!authed.ok) return authed.response;

  const catalog = await listIconCatalog(db);
  return json(catalog, 200);
}

/**
 * `POST /api/icons` — multipart/form-data with `name`, `label`, `file`.
 *
 * Teacher-gated: this is class material any student in any board can then
 * place, so adding to it is an administrative action, same tier as creating a
 * board or a student account.
 */
export async function handleIconCatalogUpload(
  db: Database,
  request: Request,
): Promise<Response> {
  const authed = await authenticate(db, request);
  if (!authed.ok) return authed.response;
  if (!isTeacher(authed.role)) {
    return json({ error: "forbidden" }, 403);
  }

  const limit = maxBoardFileBytes();
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit * 2) {
    return json({ error: "file_too_large", limit }, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "malformed_body" }, 400);
  }

  const name = form.get("name");
  if (!isValidIconName(name)) {
    return json({ error: "invalid_name" }, 400);
  }

  const rawLabel = form.get("label");
  const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
  if (label.length === 0 || label.length > 120) {
    return json({ error: "invalid_label" }, 400);
  }

  const part = form.get("file");
  if (typeof part === "string" || part === null) {
    return json({ error: "missing_file" }, 400);
  }
  if (part.size > limit) {
    return json({ error: "file_too_large", limit }, 413);
  }

  const bytes = new Uint8Array(await part.arrayBuffer());
  if (bytes.byteLength === 0) {
    return json({ error: "empty_file" }, 400);
  }
  if (bytes.byteLength > limit) {
    return json({ error: "file_too_large", limit }, 413);
  }

  const declaredType = part.type.split(";")[0]?.trim().toLowerCase() ?? "";
  const sniffed = sniffImageMimeType(bytes);
  if (sniffed === null) {
    return json({ error: "unsupported_media_type" }, 415);
  }
  if (!isAllowedImageMimeType(declaredType) || declaredType !== sniffed) {
    return json({ error: "unsupported_media_type" }, 415);
  }

  try {
    const row = await saveIconCatalogEntry(db, {
      name,
      label,
      mimeType: sniffed,
      bytes,
      createdBy: authed.userId,
    });
    return json(
      { name: row.name, label: row.label, fileId: row.fileId },
      201,
    );
  } catch (error) {
    if (error instanceof IconNameTakenError) {
      return json({ error: "name_taken" }, 409);
    }
    throw error;
  }
}

/** `GET`/`HEAD /api/icons/:fileId` — the raw bytes of one catalog icon. */
export async function handleIconDownload(
  db: Database,
  request: Request,
  fileId: string,
): Promise<Response> {
  const authed = await authenticate(db, request);
  if (!authed.ok) return authed.response;

  const icon = await getIconByFileId(db, fileId);
  if (!icon) return notFound();

  // The bytes never change under a given fileId (a rename would be a new
  // catalog row, not an edit — there is no edit path), so a strong ETag is
  // honest here, same reasoning as `handleBoardFileDownload`.
  const etag = `"${fileId}"`;
  const headers = new Headers({
    "content-type": icon.mimeType,
    etag,
    "cache-control": "private, max-age=31536000, immutable",
    vary: "Cookie",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    "content-security-policy": "default-src 'none'; sandbox",
  });

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.split(",").some((v) => v.trim() === etag)) {
    return new Response(null, { status: 304, headers });
  }

  headers.set("content-length", String(icon.bytes.byteLength));
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(new Uint8Array(icon.bytes), { status: 200, headers });
}
