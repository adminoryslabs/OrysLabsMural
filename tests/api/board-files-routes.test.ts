import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session-cookie";
import { createSession } from "@/lib/auth/session";
import {
  handleBoardFileDownload,
  handleBoardFileUpload,
} from "@/lib/boards/file-http";
import { getBoardFile } from "@/lib/boards/files";
import { setBoardStatus } from "@/lib/boards/queries";
import type { BoardStatus } from "@/lib/db/schema";
import { resetDatabase, testDb } from "../setup/db";
import { seedBoardWithMember, type BoardFixture } from "../setup/fixtures";
import {
  GIF_1x1,
  JPEG_1x1,
  MALICIOUS_SVG,
  PNG_1x1,
  WEBP_1x1,
  oversizedPng,
} from "../setup/images";

/**
 * These drive the shipped handlers with real `Request` objects, real multipart
 * bodies and real session cookies against the real test database. The route
 * files under `app/api/` are three-line adapters over exactly these functions.
 */

const BASE = "http://localhost/api/boards";

async function cookieFor(userId: string): Promise<string> {
  const { token } = await createSession(testDb, userId);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function uploadRequest(
  boardId: string,
  options: {
    cookie?: string | null;
    fileId?: string | null;
    bytes?: Uint8Array;
    type?: string;
    filename?: string;
  } = {},
): Request {
  const form = new FormData();
  if (options.fileId !== null) {
    form.append("fileId", options.fileId ?? "picture-one");
  }
  if (options.bytes) {
    form.append(
      "file",
      new Blob([options.bytes as BlobPart], {
        type: options.type ?? "image/png",
      }),
      options.filename ?? "image.png",
    );
  }
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  return new Request(`${BASE}/${boardId}/files`, {
    method: "POST",
    body: form,
    headers,
  });
}

function downloadRequest(
  boardId: string,
  fileId: string,
  cookie?: string | null,
  extraHeaders: Record<string, string> = {},
): Request {
  const headers = new Headers(extraHeaders);
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${BASE}/${boardId}/files/${fileId}`, { headers });
}

function upload(boardId: string, options: Parameters<typeof uploadRequest>[1]) {
  return handleBoardFileUpload(testDb, uploadRequest(boardId, options), boardId);
}

function download(
  boardId: string,
  fileId: string,
  cookie?: string | null,
  extraHeaders: Record<string, string> = {},
) {
  return handleBoardFileDownload(
    testDb,
    downloadRequest(boardId, fileId, cookie, extraHeaders),
    boardId,
    fileId,
  );
}

/** Uploads one known-good PNG as somebody allowed to, for the read tests. */
async function seedFile(room: BoardFixture, fileId = "picture-one") {
  const cookie = await cookieFor(room.teacher.id);
  const response = await upload(room.board.id, {
    cookie,
    fileId,
    bytes: PNG_1x1,
    type: "image/png",
  });
  expect(response.status).toBe(201);
}

beforeEach(async () => {
  await resetDatabase();
});

describe("POST /api/boards/:boardId/files — authentication", () => {
  it("refuses an upload with no cookie at all", async () => {
    const room = await seedBoardWithMember();
    const response = await upload(room.board.id, {
      bytes: PNG_1x1,
      cookie: null,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it("refuses a forged session token", async () => {
    const room = await seedBoardWithMember();
    const response = await upload(room.board.id, {
      cookie: `${SESSION_COOKIE_NAME}=${"f".repeat(43)}`,
      bytes: PNG_1x1,
    });
    expect(response.status).toBe(401);
  });

  it("refuses a cookie whose session has been invalidated", async () => {
    const room = await seedBoardWithMember();
    const cookie = await cookieFor(room.student.id);
    const { invalidateSession } = await import("@/lib/auth/session");
    await invalidateSession(testDb, cookie.split("=")[1]!);

    const response = await upload(room.board.id, { cookie, bytes: PNG_1x1 });
    expect(response.status).toBe(401);
  });

  it("stores nothing on a refused upload", async () => {
    const room = await seedBoardWithMember();
    await upload(room.board.id, { cookie: null, bytes: PNG_1x1 });
    expect(await getBoardFile(testDb, room.board.id, "picture-one")).toBeNull();
  });
});

describe("POST /api/boards/:boardId/files — a non-member is a missing board", () => {
  it("answers a non-member with 404, never 403", async () => {
    const room = await seedBoardWithMember();
    const cookie = await cookieFor(room.outsider.id);
    const response = await upload(room.board.id, { cookie, bytes: PNG_1x1 });
    expect(response.status).toBe(404);
  });

  it("answers identically for a board that does not exist", async () => {
    const room = await seedBoardWithMember();
    const cookie = await cookieFor(room.outsider.id);

    const nonMember = await upload(room.board.id, { cookie, bytes: PNG_1x1 });
    const missing = await upload(randomUUID(), { cookie, bytes: PNG_1x1 });

    // Byte for byte the same answer: membership of a class is not something an
    // outsider gets to enumerate by watching status codes or bodies.
    expect(missing.status).toBe(nonMember.status);
    expect(await missing.text()).toBe(await nonMember.text());
    expect(nonMember.status).toBe(404);
  });

  it("does not leak through a malformed board id either", async () => {
    const room = await seedBoardWithMember();
    const cookie = await cookieFor(room.outsider.id);
    const response = await upload("not-a-uuid", { cookie, bytes: PNG_1x1 });
    expect(response.status).toBe(404);
  });
});

describe("POST /api/boards/:boardId/files — uploading is writing", () => {
  const cases: Array<{ status: BoardStatus; who: "student" | "teacher" }> = [
    { status: "frozen", who: "student" },
    { status: "frozen", who: "teacher" },
    { status: "readonly", who: "student" },
  ];

  for (const { status, who } of cases) {
    it(`refuses a ${who} on a ${status} board`, async () => {
      const room = await seedBoardWithMember(status);
      const cookie = await cookieFor(room[who].id);
      const response = await upload(room.board.id, { cookie, bytes: PNG_1x1 });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "board_not_writable",
        status,
      });
      expect(
        await getBoardFile(testDb, room.board.id, "picture-one"),
      ).toBeNull();
    });
  }

  it("accepts a member on an active board", async () => {
    const room = await seedBoardWithMember("active");
    const cookie = await cookieFor(room.student.id);
    const response = await upload(room.board.id, { cookie, bytes: PNG_1x1 });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      fileId: "picture-one",
      mimeType: "image/png",
      byteSize: PNG_1x1.byteLength,
    });
  });

  it("accepts a teacher on a read-only board — read only binds students", async () => {
    const room = await seedBoardWithMember("readonly");
    const cookie = await cookieFor(room.teacher.id);
    const response = await upload(room.board.id, { cookie, bytes: PNG_1x1 });
    expect(response.status).toBe(201);
  });

  it("bites on the very next upload after a freeze, with no reconnect", async () => {
    const room = await seedBoardWithMember("active");
    const cookie = await cookieFor(room.student.id);

    expect(
      (await upload(room.board.id, { cookie, fileId: "before", bytes: PNG_1x1 }))
        .status,
    ).toBe(201);

    // The teacher freezes the board. Nothing about the client changes: same
    // user, same cookie, same request shape.
    await setBoardStatus(testDb, room.board.id, "frozen");

    expect(
      (await upload(room.board.id, { cookie, fileId: "after", bytes: PNG_1x1 }))
        .status,
    ).toBe(403);
    expect(await getBoardFile(testDb, room.board.id, "after")).toBeNull();

    // And an unfreeze bites just as immediately, in the other direction.
    await setBoardStatus(testDb, room.board.id, "active");
    expect(
      (await upload(room.board.id, { cookie, fileId: "after", bytes: PNG_1x1 }))
        .status,
    ).toBe(201);
  });
});

describe("POST /api/boards/:boardId/files — what may be stored", () => {
  it("accepts every format on the allowlist", async () => {
    const room = await seedBoardWithMember();
    const cookie = await cookieFor(room.student.id);
    const formats = [
      ["image/png", PNG_1x1],
      ["image/jpeg", JPEG_1x1],
      ["image/gif", GIF_1x1],
      ["image/webp", WEBP_1x1],
    ] as const;

    for (const [type, bytes] of formats) {
      const response = await upload(room.board.id, {
        cookie,
        fileId: type.replace("/", "-"),
        bytes,
        type,
      });
      expect([type, response.status]).toEqual([type, 201]);
    }
  });

  it("refuses an svg even when the client declares it honestly", async () => {
    const room = await seedBoardWithMember();
    const cookie = await cookieFor(room.student.id);
    const response = await upload(room.board.id, {
      cookie,
      bytes: MALICIOUS_SVG,
      type: "image/svg+xml",
    });
    expect(response.status).toBe(415);
    expect(await getBoardFile(testDb, room.board.id, "picture-one")).toBeNull();
  });

  it("refuses an svg dressed up as a png — the bytes decide, not the header", async () => {
    const room = await seedBoardWithMember();
    const cookie = await cookieFor(room.student.id);
    const response = await upload(room.board.id, {
      cookie,
      bytes: MALICIOUS_SVG,
      type: "image/png",
      filename: "innocent.png",
    });
    expect(response.status).toBe(415);
    expect(await getBoardFile(testDb, room.board.id, "picture-one")).toBeNull();
  });

  it("refuses a real png that lies about being a jpeg", async () => {
    const room = await seedBoardWithMember();
    const cookie = await cookieFor(room.student.id);
    const response = await upload(room.board.id, {
      cookie,
      bytes: PNG_1x1,
      type: "image/jpeg",
    });
    expect(response.status).toBe(415);
  });

  it("refuses an empty body and a missing file part", async () => {
    const room = await seedBoardWithMember();
    const cookie = await cookieFor(room.student.id);

    expect(
      (await upload(room.board.id, { cookie, bytes: new Uint8Array(0) })).status,
    ).toBe(400);
    expect((await upload(room.board.id, { cookie })).status).toBe(400);
  });

  it("refuses a missing or hostile file id", async () => {
    const room = await seedBoardWithMember();
    const cookie = await cookieFor(room.student.id);

    expect(
      (await upload(room.board.id, { cookie, fileId: null, bytes: PNG_1x1 }))
        .status,
    ).toBe(400);
    expect(
      (
        await upload(room.board.id, {
          cookie,
          fileId: "../../../etc/passwd",
          bytes: PNG_1x1,
        })
      ).status,
    ).toBe(400);
  });

  it("enforces the size limit", async () => {
    const room = await seedBoardWithMember();
    const cookie = await cookieFor(room.student.id);
    const previous = process.env.BOARD_FILE_MAX_BYTES;
    process.env.BOARD_FILE_MAX_BYTES = "2048";
    try {
      const tooBig = await upload(room.board.id, {
        cookie,
        fileId: "too-big",
        bytes: oversizedPng(4096),
      });
      expect(tooBig.status).toBe(413);
      expect(await tooBig.json()).toEqual({
        error: "file_too_large",
        limit: 2048,
      });
      expect(await getBoardFile(testDb, room.board.id, "too-big")).toBeNull();

      // Just under the limit still goes through, so the boundary is a limit
      // and not a blanket refusal.
      const small = await upload(room.board.id, {
        cookie,
        fileId: "small",
        bytes: oversizedPng(1024),
      });
      expect(small.status).toBe(201);
    } finally {
      if (previous === undefined) delete process.env.BOARD_FILE_MAX_BYTES;
      else process.env.BOARD_FILE_MAX_BYTES = previous;
    }
  });

  it("records who uploaded, on the HTTP path too", async () => {
    const room = await seedBoardWithMember();
    const cookie = await cookieFor(room.student.id);
    await upload(room.board.id, { cookie, bytes: PNG_1x1 });

    const stored = await getBoardFile(testDb, room.board.id, "picture-one");
    expect(stored!.createdBy).toBe(room.student.id);
  });

  it("is idempotent over HTTP: the same file id twice both succeed", async () => {
    const room = await seedBoardWithMember();
    const cookie = await cookieFor(room.student.id);

    const first = await upload(room.board.id, { cookie, bytes: PNG_1x1 });
    const second = await upload(room.board.id, { cookie, bytes: PNG_1x1 });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const { listBoardFiles } = await import("@/lib/boards/files");
    expect(await listBoardFiles(testDb, room.board.id)).toHaveLength(1);
  });
});

describe("GET /api/boards/:boardId/files/:fileId", () => {
  it("returns the exact bytes and mime type that were uploaded", async () => {
    const room = await seedBoardWithMember();
    const cookie = await cookieFor(room.student.id);
    await upload(room.board.id, {
      cookie,
      fileId: "round-trip",
      bytes: JPEG_1x1,
      type: "image/jpeg",
    });

    const response = await download(room.board.id, "round-trip", cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");

    const received = new Uint8Array(await response.arrayBuffer());
    expect(received).toEqual(JPEG_1x1);
  });

  it("refuses without a cookie", async () => {
    const room = await seedBoardWithMember();
    await seedFile(room);
    expect((await download(room.board.id, "picture-one", null)).status).toBe(
      401,
    );
  });

  it("refuses a forged cookie", async () => {
    const room = await seedBoardWithMember();
    await seedFile(room);
    const response = await download(
      room.board.id,
      "picture-one",
      `${SESSION_COOKIE_NAME}=${"0".repeat(43)}`,
    );
    expect(response.status).toBe(401);
  });

  it("hides a file from somebody who is not on the board", async () => {
    const room = await seedBoardWithMember();
    await seedFile(room);
    const cookie = await cookieFor(room.outsider.id);

    const response = await download(room.board.id, "picture-one", cookie);
    expect(response.status).toBe(404);
    // Nothing of the file escapes with the refusal.
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
  });

  it("answers a non-member exactly as it answers a missing board", async () => {
    const room = await seedBoardWithMember();
    await seedFile(room);
    const cookie = await cookieFor(room.outsider.id);

    const nonMember = await download(room.board.id, "picture-one", cookie);
    const missingBoard = await download(randomUUID(), "picture-one", cookie);

    expect(missingBoard.status).toBe(nonMember.status);
    expect(await missingBoard.text()).toBe(await nonMember.text());
  });

  it("answers a missing file the same way, so ids cannot be enumerated", async () => {
    const room = await seedBoardWithMember();
    await seedFile(room);
    const memberCookie = await cookieFor(room.student.id);
    const outsiderCookie = await cookieFor(room.outsider.id);

    const missingFile = await download(
      room.board.id,
      "no-such-file",
      memberCookie,
    );
    const notYourBoard = await download(
      room.board.id,
      "picture-one",
      outsiderCookie,
    );

    expect(missingFile.status).toBe(404);
    expect(await missingFile.text()).toBe(await notYourBoard.text());
  });

  it("still serves images on a frozen board — freezing stops writes, not eyes", async () => {
    const room = await seedBoardWithMember("active");
    await seedFile(room);
    await setBoardStatus(testDb, room.board.id, "frozen");

    const cookie = await cookieFor(room.student.id);
    const response = await download(room.board.id, "picture-one", cookie);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_1x1);
  });

  it("still serves images on a read-only board", async () => {
    const room = await seedBoardWithMember("active");
    await seedFile(room);
    await setBoardStatus(testDb, room.board.id, "readonly");

    const cookie = await cookieFor(room.student.id);
    expect((await download(room.board.id, "picture-one", cookie)).status).toBe(
      200,
    );
  });

  it("lets a supervising teacher read a board's images", async () => {
    const room = await seedBoardWithMember();
    await seedFile(room);
    const cookie = await cookieFor(room.teacher.id);
    expect((await download(room.board.id, "picture-one", cookie)).status).toBe(
      200,
    );
  });

  it("caches immutably, privately, and per cookie", async () => {
    const room = await seedBoardWithMember();
    await seedFile(room);
    const cookie = await cookieFor(room.student.id);
    const response = await download(room.board.id, "picture-one", cookie);

    expect(response.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("etag")).toBe('"picture-one"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers 304 to a matching ETag", async () => {
    const room = await seedBoardWithMember();
    await seedFile(room);
    const cookie = await cookieFor(room.student.id);

    const fresh = await download(room.board.id, "picture-one", cookie);
    const etag = fresh.headers.get("etag")!;

    const revalidated = await download(room.board.id, "picture-one", cookie, {
      "if-none-match": etag,
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.arrayBuffer()).toEqual(new ArrayBuffer(0));

    const stale = await download(room.board.id, "picture-one", cookie, {
      "if-none-match": '"something-else"',
    });
    expect(stale.status).toBe(200);
  });

  it("does not serve one board's file to another board", async () => {
    const first = await seedBoardWithMember();
    const second = await seedBoardWithMember();
    await seedFile(first, "only-on-the-first");

    // The teacher may view both boards, so this isolates the board scoping of
    // the lookup rather than the authorisation.
    const cookie = await cookieFor(second.teacher.id);
    const response = await download(
      second.board.id,
      "only-on-the-first",
      cookie,
    );
    expect(response.status).toBe(404);
  });
});
