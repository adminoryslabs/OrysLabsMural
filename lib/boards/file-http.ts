import { validateSessionToken } from "@/lib/auth/session";
import { readSessionTokenFromCookieHeader } from "@/lib/auth/session-cookie";
import type { Database } from "@/lib/db";
import { getBoardAccess, type BoardAccess } from "@/lib/boards/queries";
import {
  getBoardFile,
  isAllowedImageMimeType,
  isValidFileId,
  maxBoardFileBytes,
  saveBoardFile,
  sniffImageMimeType,
} from "./files";

/**
 * THE HTTP SIDE OF THE BINARY ASSET STORE, WITHOUT NEXT.
 *
 * These are plain `Request` -> `Response` functions taking the database
 * explicitly, exactly like `lib/` is shared with the websocket server. The
 * route files under `app/api/` are three-line adapters. The authority rules
 * therefore exist once, and the test suite exercises the shipped code rather
 * than a re-implementation of it.
 *
 * AUTHORITY LIVES HERE, NOT IN THE CLIENT. Nothing in the request body or in a
 * header is an input to the decision: the session cookie names a user, and
 * `getBoardAccess` reads the board, the role and the membership out of the
 * database. A client that ignores the status pushed over the websocket, or
 * forges one, gains nothing on these two routes.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // These answers depend on who is asking. Never let anything cache them.
      "cache-control": "no-store",
    },
  });
}

/**
 * The one refusal a probe must not be able to read anything out of.
 *
 * A board that does not exist and a board that exists but is not this user's
 * are the same answer, byte for byte — the same property Phase A's `notFound()`
 * and Phase B's 4404 close code give. Membership of a class is not something an
 * outsider gets to enumerate.
 */
function notFound(): Response {
  return json({ error: "not_found" }, 404);
}

function unauthenticated(): Response {
  return json({ error: "unauthenticated" }, 401);
}

type Authorised =
  | { ok: true; userId: string; access: BoardAccess }
  | { ok: false; response: Response };

/**
 * Resolves the cookie to a user, then the user to an access verdict on this
 * board. Everything below `canView` collapses into the same 404.
 */
async function authorise(
  db: Database,
  request: Request,
  boardId: string,
): Promise<Authorised> {
  const token = readSessionTokenFromCookieHeader(request.headers.get("cookie"));
  if (!token) return { ok: false, response: unauthenticated() };

  const { user } = await validateSessionToken(db, token);
  // A forged, expired or revoked token resolves to nobody.
  if (!user) return { ok: false, response: unauthenticated() };

  // A malformed board id must never reach SQL, where an invalid uuid raises
  // instead of returning "no rows" — a 500 would itself be a probe signal.
  if (!UUID_PATTERN.test(boardId)) {
    return { ok: false, response: notFound() };
  }

  const access = await getBoardAccess(db, boardId, user.id);
  if (!access || !access.canView) {
    return { ok: false, response: notFound() };
  }

  return { ok: true, userId: user.id, access };
}

/**
 * `POST /api/boards/:boardId/files` — multipart/form-data with `fileId` and
 * `file`.
 *
 * UPLOADING IS WRITING. A frozen or read-only board refuses it for exactly the
 * same reason it refuses a Yjs update: `canWrite` is re-read from the database
 * here, on every request. There is no cached verdict and no client-supplied
 * status, so freezing a board mid-class stops the next paste as surely as it
 * stops the next stroke.
 */
export async function handleBoardFileUpload(
  db: Database,
  request: Request,
  boardId: string,
): Promise<Response> {
  const authorised = await authorise(db, request, boardId);
  if (!authorised.ok) return authorised.response;

  const { access, userId } = authorised;
  if (!access.canWrite) {
    // The caller can already see this board, so naming the reason leaks
    // nothing — and the client needs it to explain itself to the user.
    return json(
      { error: "board_not_writable", status: access.board.status },
      403,
    );
  }

  const limit = maxBoardFileBytes();

  // Reject an oversized body before reading it, when the sender declared how
  // big it is. The real check is on the bytes below; this one only saves us
  // buffering a body we have already decided to refuse.
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

  const fileId = form.get("fileId");
  if (!isValidFileId(fileId)) {
    return json({ error: "invalid_file_id" }, 400);
  }

  const part = form.get("file");
  if (typeof part === "string" || part === null) {
    return json({ error: "missing_file" }, 400);
  }

  if (part.size > limit) {
    return json({ error: "file_too_large", limit }, 413);
  }

  const bytes = new Uint8Array(await part.arrayBuffer());
  // `part.size` is what the multipart framing claimed; this is what arrived.
  if (bytes.byteLength === 0) {
    return json({ error: "empty_file" }, 400);
  }
  if (bytes.byteLength > limit) {
    return json({ error: "file_too_large", limit }, 413);
  }

  // The declared type is a claim; the bytes are the evidence. Both must agree,
  // and both must be on the allowlist, because this content is served back
  // from our own origin later.
  const declaredType = part.type.split(";")[0]?.trim().toLowerCase() ?? "";
  const sniffed = sniffImageMimeType(bytes);
  if (sniffed === null) {
    return json({ error: "unsupported_media_type" }, 415);
  }
  if (!isAllowedImageMimeType(declaredType) || declaredType !== sniffed) {
    return json({ error: "unsupported_media_type" }, 415);
  }

  await saveBoardFile(db, {
    boardId,
    fileId,
    mimeType: sniffed,
    bytes,
    createdBy: userId,
  });

  return json({ fileId, mimeType: sniffed, byteSize: bytes.byteLength }, 201);
}

/**
 * `GET /api/boards/:boardId/files/:fileId`.
 *
 * `canView`, not `canWrite`: a student must still see the images on a board
 * that has just been frozen or set to read only, otherwise freezing an exercise
 * would blank out half of it.
 */
export async function handleBoardFileDownload(
  db: Database,
  request: Request,
  boardId: string,
  fileId: string,
): Promise<Response> {
  const authorised = await authorise(db, request, boardId);
  if (!authorised.ok) return authorised.response;

  if (!isValidFileId(fileId)) return notFound();

  const file = await getBoardFile(db, boardId, fileId);
  if (!file) return notFound();

  // Excalidraw derives the file id from the content, and this route never
  // updates a row, so the id IS the version. A strong ETag is honest here.
  const etag = `"${fileId}"`;
  const headers = new Headers({
    "content-type": file.mimeType,
    etag,
    // Immutable, but `private` and varying on the cookie: the answer depends on
    // who asked, so no shared cache may ever hand it to the next person.
    "cache-control": "private, max-age=31536000, immutable",
    vary: "Cookie",
    // The type was sniffed on the way in; forbid the browser sniffing its own
    // way to a different, scriptable interpretation on the way out.
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    "content-security-policy": "default-src 'none'; sandbox",
  });

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.split(",").some((v) => v.trim() === etag)) {
    return new Response(null, { status: 304, headers });
  }

  headers.set("content-length", String(file.bytes.byteLength));
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  // Copy out of the Buffer: the driver's memory is not ours to hand to the
  // response stream.
  return new Response(new Uint8Array(file.bytes), { status: 200, headers });
}
