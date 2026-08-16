import { and, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { boardFiles, type BoardFile } from "@/lib/db/schema";

/**
 * BINARY ASSET STORE.
 *
 * The bytes of an image never enter the Yjs document (see the comment on
 * `boardFiles` in the schema). This module is the only place that reads or
 * writes them, and it is framework free so a route handler, a script or a
 * future maintenance job all go through the same rules.
 */

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * What we are willing to store and, more importantly, to serve back from our
 * own origin.
 *
 * SVG IS DELIBERATELY ABSENT. An SVG is a document, not a picture: it may carry
 * `<script>`, `<foreignObject>` and event handlers, and a browser executes them
 * when it renders one served inline. Serving one from this origin would hand
 * any student a stored cross-site scripting primitive against the whole class,
 * session cookie included. Raster formats have no scripting surface, so the
 * allowlist is raster only. Excalidraw's own shapes stay vectorial regardless;
 * this only restricts what may be pasted in as an image.
 */
export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export function isAllowedImageMimeType(
  value: unknown,
): value is AllowedImageMimeType {
  return (
    typeof value === "string" &&
    (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(value)
  );
}

/** Upload ceiling, overridable with `BOARD_FILE_MAX_BYTES`. */
export function maxBoardFileBytes(): number {
  const raw = Number(process.env.BOARD_FILE_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_BYTES;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * Identifies the format from the bytes themselves.
 *
 * The `Content-Type` a client attaches is a claim, not evidence, and this
 * content is served back from our own origin. Sniffing is what stops an SVG (or
 * an HTML file) from being stored and later served under a `image/png` label
 * that a browser may well decide to ignore. Returns null for anything we do not
 * positively recognise, which is the answer that rejects the upload.
 */
export function sniffImageMimeType(
  bytes: Uint8Array,
): AllowedImageMimeType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif";
  }
  // RIFF....WEBP
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    startsWith(bytes.subarray(8, 12), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  return null;
}

/** Excalidraw file ids are opaque, but they end up in a URL and in SQL. */
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

export function isValidFileId(value: unknown): value is string {
  return typeof value === "string" && FILE_ID_PATTERN.test(value);
}

export interface SaveBoardFileInput {
  boardId: string;
  fileId: string;
  mimeType: AllowedImageMimeType;
  bytes: Uint8Array;
  createdBy: string;
}

/**
 * Stores the bytes for one file on one board.
 *
 * Idempotent by design: Excalidraw derives `fileId` from the content, so a
 * re-upload of the same id is the same picture. Two students pasting the same
 * image at once, or one client retrying after a dropped response, must not turn
 * into a unique-violation on a path the user cannot retry out of. The first
 * writer keeps the attribution — the second person did not contribute the
 * bytes, they re-sent them.
 */
export async function saveBoardFile(
  db: Database,
  input: SaveBoardFileInput,
): Promise<void> {
  const bytes = Buffer.from(
    input.bytes.buffer,
    input.bytes.byteOffset,
    input.bytes.byteLength,
  );
  await db
    .insert(boardFiles)
    .values({
      boardId: input.boardId,
      fileId: input.fileId,
      mimeType: input.mimeType,
      bytes,
      byteSize: bytes.byteLength,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing({
      target: [boardFiles.boardId, boardFiles.fileId],
    });
}

export async function getBoardFile(
  db: Database,
  boardId: string,
  fileId: string,
): Promise<BoardFile | null> {
  const [row] = await db
    .select()
    .from(boardFiles)
    .where(and(eq(boardFiles.boardId, boardId), eq(boardFiles.fileId, fileId)))
    .limit(1);
  return row ?? null;
}

export interface BoardFileSummary {
  fileId: string;
  mimeType: string;
  byteSize: number;
  createdBy: string;
  createdAt: Date;
}

/** Metadata only — never the bytes. Used for reporting and housekeeping. */
export async function listBoardFiles(
  db: Database,
  boardId: string,
): Promise<BoardFileSummary[]> {
  return db
    .select({
      fileId: boardFiles.fileId,
      mimeType: boardFiles.mimeType,
      byteSize: boardFiles.byteSize,
      createdBy: boardFiles.createdBy,
      createdAt: boardFiles.createdAt,
    })
    .from(boardFiles)
    .where(eq(boardFiles.boardId, boardId));
}
