import { describe, expect, it } from "vitest";
import {
  boardFileUrl,
  dataUrlToBlob,
  describeUploadFailure,
  formatBytes,
  referencedFileIds,
} from "@/lib/collab/board-files";
import { PNG_1x1 } from "../setup/images";

/**
 * The browser half of the image link. Only the parts that decide something are
 * covered here — the `fetch` calls themselves are wiring, and the routes they
 * talk to are exercised for real in tests/api.
 */

describe("which files the scene needs", () => {
  const image = (fileId: string | null, isDeleted = false) => ({
    type: "image",
    fileId,
    isDeleted,
  });

  it("collects the files of live image elements", () => {
    const ids = referencedFileIds([
      image("one"),
      { type: "rectangle" },
      image("two"),
      image("one"),
    ]);
    expect([...ids].sort()).toEqual(["one", "two"]);
  });

  it("ignores deleted images", () => {
    // This is what stops a rejected upload being retried forever: the element
    // is marked deleted, so the file stops being referenced at all.
    expect(referencedFileIds([image("gone", true)]).size).toBe(0);
  });

  it("ignores an image element that has no file yet", () => {
    expect(referencedFileIds([image(null)]).size).toBe(0);
    expect(referencedFileIds([{ type: "image" }]).size).toBe(0);
  });
});

describe("decoding what Excalidraw holds an image in", () => {
  it("round-trips a base64 data url back to the original bytes", async () => {
    const base64 = Buffer.from(PNG_1x1).toString("base64");
    const blob = dataUrlToBlob(`data:image/png;base64,${base64}`);

    expect(blob).not.toBeNull();
    expect(blob!.type).toBe("image/png");
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(PNG_1x1);
  });

  it("refuses anything that is not a base64 data url", () => {
    expect(dataUrlToBlob("https://example.com/cat.png")).toBeNull();
    expect(dataUrlToBlob("data:image/svg+xml,<svg/>")).toBeNull();
    expect(dataUrlToBlob("data:image/png;base64")).toBeNull();
    expect(dataUrlToBlob("")).toBeNull();
  });

  it("refuses a corrupt payload rather than uploading garbage", () => {
    expect(dataUrlToBlob("data:image/png;base64,!!!not base64!!!")).toBeNull();
  });
});

describe("classifying a refusal", () => {
  it("never retries a refusal the server will repeat", () => {
    for (const status of [400, 401, 403, 404, 413, 415]) {
      expect([status, describeUploadFailure(status, null).retry]).toEqual([
        status,
        false,
      ]);
    }
  });

  it("retries anything it does not recognise", () => {
    // Deleting a student's work over an unknown status code would be worse
    // than one wasted request.
    for (const status of [500, 502, 503, 429, 418]) {
      expect([status, describeUploadFailure(status, null).retry]).toEqual([
        status,
        true,
      ]);
    }
  });

  it("tells the user the limit it just hit", () => {
    const { message } = describeUploadFailure(413, {
      error: "file_too_large",
      limit: 5 * 1024 * 1024,
    });
    expect(message).toContain("5 MB");
  });

  it("names the formats that would have worked", () => {
    expect(describeUploadFailure(415, null).message).toContain("PNG");
  });
});

describe("formatBytes", () => {
  it("reads the way a limit should", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
    expect(formatBytes(64 * 1024)).toBe("64 KB");
  });
});

describe("boardFileUrl", () => {
  it("escapes both segments", () => {
    expect(boardFileUrl("board id", "file/id")).toBe(
      "/api/boards/board%20id/files/file%2Fid",
    );
  });
});
