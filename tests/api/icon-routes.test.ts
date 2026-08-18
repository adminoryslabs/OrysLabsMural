import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session-cookie";
import { createSession } from "@/lib/auth/session";
import {
  handleIconCatalogList,
  handleIconCatalogUpload,
  handleIconDownload,
} from "@/lib/icons/icon-http";
import { resetDatabase, testDb } from "../setup/db";
import { seedBoardWithMember } from "../setup/fixtures";
import { GIF_1x1, MALICIOUS_SVG, PNG_1x1 } from "../setup/images";

/**
 * Drives the shipped handlers directly, exactly like `board-files-routes.test.ts`
 * does for the per-board equivalent — the route files under `app/api/icons`
 * are three-line adapters over exactly these functions.
 */

async function cookieFor(userId: string): Promise<string> {
  const { token } = await createSession(testDb, userId);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function uploadRequest(options: {
  cookie?: string | null;
  name?: string | null;
  label?: string | null;
  bytes?: Uint8Array;
  type?: string;
} = {}): Request {
  const form = new FormData();
  if (options.name !== null) form.append("name", options.name ?? "rocket");
  if (options.label !== null) form.append("label", options.label ?? "Rocket");
  if (options.bytes) {
    form.append(
      "file",
      new Blob([options.bytes as BlobPart], { type: options.type ?? "image/png" }),
      "icon.png",
    );
  }
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  return new Request("http://localhost/api/icons", {
    method: "POST",
    body: form,
    headers,
  });
}

function upload(options: Parameters<typeof uploadRequest>[0]) {
  return handleIconCatalogUpload(testDb, uploadRequest(options));
}

function list(cookie?: string | null) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return handleIconCatalogList(
    testDb,
    new Request("http://localhost/api/icons", { headers }),
  );
}

function download(
  fileId: string,
  cookie?: string | null,
  extraHeaders: Record<string, string> = {},
) {
  const headers = new Headers(extraHeaders);
  if (cookie) headers.set("cookie", cookie);
  return handleIconDownload(
    testDb,
    new Request(`http://localhost/api/icons/${fileId}`, { headers }),
    fileId,
  );
}

beforeEach(async () => {
  await resetDatabase();
});

describe("POST /api/icons — authentication and authorisation", () => {
  it("refuses an upload with no cookie", async () => {
    const response = await upload({ bytes: PNG_1x1 });
    expect(response.status).toBe(401);
  });

  it("refuses a student — only a teacher may add to the catalog", async () => {
    const { student } = await seedBoardWithMember();
    const cookie = await cookieFor(student.id);
    const response = await upload({ cookie, bytes: PNG_1x1 });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("accepts a teacher", async () => {
    const { teacher } = await seedBoardWithMember();
    const cookie = await cookieFor(teacher.id);
    const response = await upload({ cookie, bytes: PNG_1x1 });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      name: "rocket",
      label: "Rocket",
      fileId: "icon-rocket",
    });
  });
});

describe("POST /api/icons — validation", () => {
  it("rejects a name outside the slug pattern", async () => {
    const { teacher } = await seedBoardWithMember();
    const cookie = await cookieFor(teacher.id);
    const response = await upload({
      cookie,
      name: "Not A Slug!",
      bytes: PNG_1x1,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_name" });
  });

  it("rejects an empty label", async () => {
    const { teacher } = await seedBoardWithMember();
    const cookie = await cookieFor(teacher.id);
    const response = await upload({ cookie, label: "  ", bytes: PNG_1x1 });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_label" });
  });

  it("refuses an svg even declared honestly — same allowlist as board files", async () => {
    const { teacher } = await seedBoardWithMember();
    const cookie = await cookieFor(teacher.id);
    const response = await upload({
      cookie,
      bytes: MALICIOUS_SVG,
      type: "image/svg+xml",
    });
    expect(response.status).toBe(415);
  });

  it("accepts a non-png format on the allowlist", async () => {
    const { teacher } = await seedBoardWithMember();
    const cookie = await cookieFor(teacher.id);
    const response = await upload({
      cookie,
      name: "gif-one",
      bytes: GIF_1x1,
      type: "image/gif",
    });
    expect(response.status).toBe(201);
  });

  it("refuses a second icon under the same name", async () => {
    const { teacher } = await seedBoardWithMember();
    const cookie = await cookieFor(teacher.id);
    expect((await upload({ cookie, bytes: PNG_1x1 })).status).toBe(201);

    const second = await upload({ cookie, bytes: PNG_1x1 });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "name_taken" });
  });
});

describe("GET /api/icons", () => {
  it("refuses an unauthenticated request", async () => {
    expect((await list(null)).status).toBe(401);
  });

  it("lists every icon a teacher added, to a student too — no board involved", async () => {
    const { teacher, student } = await seedBoardWithMember();
    const teacherCookie = await cookieFor(teacher.id);
    await upload({ cookie: teacherCookie, bytes: PNG_1x1 });

    const studentCookie = await cookieFor(student.id);
    const response = await list(studentCookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { name: "rocket", label: "Rocket", fileId: "icon-rocket" },
    ]);
  });

  it("never includes the bytes", async () => {
    const { teacher } = await seedBoardWithMember();
    const cookie = await cookieFor(teacher.id);
    await upload({ cookie, bytes: PNG_1x1 });

    const body = (await (await list(cookie)).json()) as Array<
      Record<string, unknown>
    >;
    expect(body[0]).not.toHaveProperty("bytes");
  });
});

describe("GET /api/icons/:fileId", () => {
  it("refuses without a cookie", async () => {
    const { teacher } = await seedBoardWithMember();
    const cookie = await cookieFor(teacher.id);
    await upload({ cookie, bytes: PNG_1x1 });

    expect((await download("icon-rocket", null)).status).toBe(401);
  });

  it("returns the exact bytes and mime type that were uploaded", async () => {
    const { teacher } = await seedBoardWithMember();
    const cookie = await cookieFor(teacher.id);
    await upload({ cookie, bytes: PNG_1x1 });

    const response = await download("icon-rocket", cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_1x1);
  });

  it("answers a missing icon with 404 — any authenticated user, not just a teacher", async () => {
    const { student } = await seedBoardWithMember();
    const cookie = await cookieFor(student.id);
    expect((await download("icon-does-not-exist", cookie)).status).toBe(404);
  });

  it("answers 304 to a matching ETag", async () => {
    const { teacher } = await seedBoardWithMember();
    const cookie = await cookieFor(teacher.id);
    await upload({ cookie, bytes: PNG_1x1 });

    const fresh = await download("icon-rocket", cookie);
    const etag = fresh.headers.get("etag")!;
    const revalidated = await download("icon-rocket", cookie, {
      "if-none-match": etag,
    });
    expect(revalidated.status).toBe(304);
  });
});
