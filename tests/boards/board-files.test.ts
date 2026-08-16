import { beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  getBoardFile,
  isAllowedImageMimeType,
  isValidFileId,
  listBoardFiles,
  maxBoardFileBytes,
  saveBoardFile,
  sniffImageMimeType,
} from "@/lib/boards/files";
import { resetDatabase, testDb } from "../setup/db";
import { seedClassroom } from "../setup/fixtures";
import { GIF_1x1, JPEG_1x1, PNG_1x1, WEBP_1x1 } from "../setup/images";

beforeEach(async () => {
  await resetDatabase();
});

describe("the image allowlist", () => {
  it("accepts the four raster formats and nothing else", () => {
    expect([...ALLOWED_IMAGE_MIME_TYPES]).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]);
  });

  it("refuses svg, which is the whole point of having an allowlist", () => {
    expect(isAllowedImageMimeType("image/svg+xml")).toBe(false);
    expect(isAllowedImageMimeType("text/html")).toBe(false);
    expect(isAllowedImageMimeType("application/pdf")).toBe(false);
  });
});

describe("sniffing the format from the bytes", () => {
  it("recognises every format on the allowlist", () => {
    expect(sniffImageMimeType(PNG_1x1)).toBe("image/png");
    expect(sniffImageMimeType(JPEG_1x1)).toBe("image/jpeg");
    expect(sniffImageMimeType(GIF_1x1)).toBe("image/gif");
    expect(sniffImageMimeType(WEBP_1x1)).toBe("image/webp");
  });

  it("returns null for an svg, however it is labelled", () => {
    const svg = new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
    );
    expect(sniffImageMimeType(svg)).toBeNull();
  });

  it("returns null for html and for an empty body", () => {
    expect(sniffImageMimeType(new TextEncoder().encode("<html></html>"))).toBe(
      null,
    );
    expect(sniffImageMimeType(new Uint8Array(0))).toBeNull();
  });

  it("does not mistake a truncated riff header for a webp", () => {
    expect(sniffImageMimeType(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBe(
      null,
    );
  });
});

describe("file ids", () => {
  it("accepts the shape Excalidraw produces", () => {
    expect(isValidFileId("mF-4t8kK9pQ_r2Zx")).toBe(true);
  });

  it("rejects anything that could travel somewhere it should not", () => {
    expect(isValidFileId("../../etc/passwd")).toBe(false);
    expect(isValidFileId("a/b")).toBe(false);
    expect(isValidFileId("")).toBe(false);
    expect(isValidFileId("x".repeat(256))).toBe(false);
    expect(isValidFileId(42)).toBe(false);
  });
});

describe("the upload limit", () => {
  it("defaults to 5 MiB", () => {
    const previous = process.env.BOARD_FILE_MAX_BYTES;
    delete process.env.BOARD_FILE_MAX_BYTES;
    try {
      expect(maxBoardFileBytes()).toBe(5 * 1024 * 1024);
    } finally {
      if (previous !== undefined) process.env.BOARD_FILE_MAX_BYTES = previous;
    }
  });

  it("is overridable, and ignores nonsense", () => {
    const previous = process.env.BOARD_FILE_MAX_BYTES;
    try {
      process.env.BOARD_FILE_MAX_BYTES = "1024";
      expect(maxBoardFileBytes()).toBe(1024);
      process.env.BOARD_FILE_MAX_BYTES = "not-a-number";
      expect(maxBoardFileBytes()).toBe(5 * 1024 * 1024);
      process.env.BOARD_FILE_MAX_BYTES = "-1";
      expect(maxBoardFileBytes()).toBe(5 * 1024 * 1024);
    } finally {
      if (previous === undefined) delete process.env.BOARD_FILE_MAX_BYTES;
      else process.env.BOARD_FILE_MAX_BYTES = previous;
    }
  });
});

describe("storing bytes", () => {
  it("round-trips them byte for byte", async () => {
    const { board, student } = await seedClassroom();
    await saveBoardFile(testDb, {
      boardId: board.id,
      fileId: "picture-one",
      mimeType: "image/png",
      bytes: PNG_1x1,
      createdBy: student.id,
    });

    const stored = await getBoardFile(testDb, board.id, "picture-one");
    expect(stored).not.toBeNull();
    expect(new Uint8Array(stored!.bytes)).toEqual(PNG_1x1);
    expect(stored!.mimeType).toBe("image/png");
    expect(stored!.byteSize).toBe(PNG_1x1.byteLength);
  });

  it("records who uploaded it", async () => {
    const { board, student } = await seedClassroom();
    await saveBoardFile(testDb, {
      boardId: board.id,
      fileId: "attributed",
      mimeType: "image/gif",
      bytes: GIF_1x1,
      createdBy: student.id,
    });

    const stored = await getBoardFile(testDb, board.id, "attributed");
    expect(stored!.createdBy).toBe(student.id);
  });

  it("is idempotent: the same file id twice does not fail", async () => {
    const { board, student, teacher } = await seedClassroom();
    const input = {
      boardId: board.id,
      fileId: "same-picture",
      mimeType: "image/png" as const,
      bytes: PNG_1x1,
      createdBy: student.id,
    };

    await saveBoardFile(testDb, input);
    await saveBoardFile(testDb, input);
    // Even from somebody else, which is what two people pasting the same
    // screenshot at the same moment looks like.
    await saveBoardFile(testDb, { ...input, createdBy: teacher.id });

    const files = await listBoardFiles(testDb, board.id);
    expect(files).toHaveLength(1);
    // The first writer keeps the attribution: the second person re-sent bytes
    // that were already there, they did not contribute them.
    expect(files[0]!.createdBy).toBe(student.id);
  });

  it("keeps the same file id on two boards independent", async () => {
    const first = await seedClassroom();
    const second = await seedClassroom();

    await saveBoardFile(testDb, {
      boardId: first.board.id,
      fileId: "shared-id",
      mimeType: "image/png",
      bytes: PNG_1x1,
      createdBy: first.student.id,
    });
    await saveBoardFile(testDb, {
      boardId: second.board.id,
      fileId: "shared-id",
      mimeType: "image/gif",
      bytes: GIF_1x1,
      createdBy: second.student.id,
    });

    const a = await getBoardFile(testDb, first.board.id, "shared-id");
    const b = await getBoardFile(testDb, second.board.id, "shared-id");
    expect(a!.mimeType).toBe("image/png");
    expect(b!.mimeType).toBe("image/gif");
    expect(new Uint8Array(b!.bytes)).toEqual(GIF_1x1);
  });

  it("goes away with the board it belongs to", async () => {
    const { board, student } = await seedClassroom();
    await saveBoardFile(testDb, {
      boardId: board.id,
      fileId: "doomed",
      mimeType: "image/png",
      bytes: PNG_1x1,
      createdBy: student.id,
    });

    const { deleteBoard } = await import("@/lib/boards/queries");
    await deleteBoard(testDb, board.id);

    expect(await getBoardFile(testDb, board.id, "doomed")).toBeNull();
  });
});
