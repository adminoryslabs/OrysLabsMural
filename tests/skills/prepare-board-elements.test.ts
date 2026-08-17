import { describe, expect, it } from "vitest";
import {
  arrow,
  assertWellFormed,
  badge,
  box,
  image,
  rectangle,
  text,
} from "../../.claude/skills/prepare-board/scripts/elements";
import { expandScene, type Shape } from "../../.claude/skills/prepare-board/scripts/skeleton";

/**
 * The bug this guards against actually happened: `arrow()` was missing
 * `groupIds`/`boundElements` entirely (not just falsy — the key was absent),
 * which is invisible to a quick look at the object and did not crash the
 * writer script — it only crashed Excalidraw's reconciliation, in a real
 * browser, the first time a human opened the board. Three layers now catch
 * it: `tsc` (now that `.claude/**\/*.ts` is in tsconfig's `include` — it
 * silently was not before, TypeScript excludes dot-folders from `**` globs by
 * default), this test, and `write-board.ts`'s own runtime call to
 * `assertWellFormed` before anything reaches the board.
 */

function expectWellFormed(el: Record<string, unknown>): void {
  expect(() => assertWellFormed(el)).not.toThrow();
}

describe("every element builder produces a complete base shape", () => {
  it("rectangle", () => {
    expectWellFormed(rectangle({ x: 0, y: 0, w: 10, h: 10 }));
  });

  it("text", () => {
    expectWellFormed(text({ x: 0, y: 0, text: "hi" }));
  });

  it("arrow — the exact shape that regressed", () => {
    expectWellFormed(arrow({ x: 0, y: 0 }, { x: 10, y: 10 }));
  });

  it("image", () => {
    expectWellFormed(image({ x: 0, y: 0, w: 10, h: 10 }, "some-file-id"));
  });

  it("badge (bound-text pair)", () => {
    for (const el of badge({ x: 0, y: 0, w: 100, h: 40 }, "SESIÓN 1")) {
      expectWellFormed(el);
    }
  });

  it("box (grouped title+body)", () => {
    for (const el of box({ x: 0, y: 0, w: 100, h: 40 }, "Title", "Body\ntext")) {
      expectWellFormed(el);
    }
  });
});

describe("assertWellFormed actually rejects the regression, not just passes good input", () => {
  it("throws on an element missing groupIds — the exact shape of the original bug", () => {
    const broken = rectangle({ x: 0, y: 0, w: 10, h: 10 }) as unknown as Record<string, unknown>;
    delete broken.groupIds;
    expect(() => assertWellFormed(broken)).toThrow(/groupIds/);
  });

  it("throws on a boundElements that is neither null nor an array", () => {
    const broken = rectangle({ x: 0, y: 0, w: 10, h: 10 }) as unknown as Record<string, unknown>;
    broken.boundElements = "not-an-array";
    expect(() => assertWellFormed(broken)).toThrow(/boundElements/);
  });
});

describe("expandScene covers every Shape variant", () => {
  const scene: Shape[] = [
    { type: "box", x: 0, y: 0, w: 100, h: 40, title: "T", body: "B" },
    { type: "badge", x: 0, y: 0, w: 100, h: 40, label: "L" },
    { type: "rectangle", x: 0, y: 0, w: 10, h: 10 },
    { type: "text", x: 0, y: 0, text: "hi" },
    { type: "arrow", from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
    { type: "image", x: 0, y: 0, w: 10, h: 10, fileId: "some-file-id" },
  ];

  it("expands every variant into well-formed elements", () => {
    const elements = expandScene(scene);
    expect(elements.length).toBeGreaterThan(0);
    for (const el of elements) {
      expectWellFormed(el as unknown as Record<string, unknown>);
    }
  });
});
