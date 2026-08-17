/**
 * Hand-built Excalidraw elements — no `@excalidraw/excalidraw` import here.
 *
 * The package cannot run outside a browser: even bundled with esbuild (which
 * resolves its dependencies correctly, unlike a bare Node `import`), it throws
 * `window is not defined` at module load time, from browser-sniffing code that
 * runs before any function is called. So this module fills in `seed`,
 * `version`, `versionNonce` and the per-type defaults itself, matching the
 * flat, documented shape of `_ExcalidrawElementBase`
 * (`@excalidraw/excalidraw/dist/types/excalidraw/element/types.d.ts`).
 *
 * Only the type imports below are erased at compile time; nothing at runtime
 * touches the package. This module is shared between the agent skill (a plain
 * Node process, see `.claude/skills/prepare-board/scripts/elements.ts`) and
 * the browser icon tool (`components/board-chrome.tsx`), which is why ids come
 * from `crypto.randomUUID()` rather than `node:crypto` — the latter has no
 * browser bundle, and `board-canvas-scene.tsx` already relies on the Web
 * Crypto global for the same reason.
 */
import type {
  ExcalidrawArrowElement,
  ExcalidrawImageElement,
  ExcalidrawRectangleElement,
  ExcalidrawTextElement,
  FileId,
} from "@excalidraw/excalidraw/element/types";

function randInt(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/**
 * Every field `_ExcalidrawElementBase` declares as non-optional, including
 * `groupIds`/`boundElements` — every element type has them in the real type,
 * so leaving either out of an arrow or an image is exactly what produces a
 * silent `undefined` that Excalidraw's own reconciliation crashes on with
 * "Cannot read properties of undefined (reading 'length')". Callers that need
 * a non-default value override these keys explicitly; they must never be
 * absent.
 */
function baseFields() {
  return {
    seed: randInt(),
    version: 1,
    versionNonce: randInt(),
    index: null,
    isDeleted: false,
    frameId: null,
    updated: Date.now(),
    link: null,
    locked: false,
    angle: 0,
    opacity: 100,
    groupIds: [] as string[],
    boundElements: null as { id: string; type: "text" | "arrow" }[] | null,
  };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  roughness?: number;
}

/** A rough-edged rectangle. `roughness: 1` is the hand-drawn look; 0 is clean. */
export function rectangle(
  box: Box,
  extra: {
    groupIds?: string[];
    boundElements?: { id: string; type: "text" | "arrow" }[] | null;
  } = {},
): ExcalidrawRectangleElement {
  return {
    ...baseFields(),
    id: crypto.randomUUID(),
    type: "rectangle",
    x: box.x,
    y: box.y,
    width: box.w,
    height: box.h,
    strokeColor: box.stroke ?? "#12141f",
    backgroundColor: box.fill ?? "transparent",
    fillStyle: "solid",
    strokeWidth: box.strokeWidth ?? 2,
    strokeStyle: "solid",
    roughness: box.roughness ?? 1,
    roundness: { type: 3 },
    groupIds: extra.groupIds ?? [],
    boundElements: extra.boundElements ?? null,
  };
}

export interface TextOptions {
  x: number;
  y: number;
  text: string;
  fontSize?: number;
  color?: string;
  width?: number;
  align?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  containerId?: string | null;
  groupIds?: string[];
}

/** Standalone text. Excalidraw cannot mix two font sizes in one text element —
 * a title and a body are always two of these, never one. */
export function text(opts: TextOptions): ExcalidrawTextElement {
  const fontSize = opts.fontSize ?? 16;
  const lines = opts.text.split("\n").length;
  return {
    ...baseFields(),
    id: crypto.randomUUID(),
    type: "text",
    x: opts.x,
    y: opts.y,
    width: opts.width ?? Math.max(40, opts.text.length * fontSize * 0.55),
    height: fontSize * 1.25 * lines,
    strokeColor: opts.color ?? "#12141f",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    roundness: null,
    fontSize,
    fontFamily: 1,
    text: opts.text,
    originalText: opts.text,
    textAlign: opts.align ?? "left",
    verticalAlign: opts.verticalAlign ?? "top",
    containerId: opts.containerId ?? null,
    autoResize: true,
    // Branded number type with no runtime meaning — the value is unitless
    // line height, Excalidraw just wants the nominal type to line up.
    lineHeight: 1.25 as ExcalidrawTextElement["lineHeight"],
    groupIds: opts.groupIds ?? [],
  };
}

/**
 * Rectangle + ONE line of text, bound for real (`boundElements` on the
 * container, `containerId` on the text). Moving or resizing the box carries
 * the label with it because Excalidraw treats them as a single object — not
 * because of grouping. Use for short single-line labels only; Excalidraw
 * cannot bind more than one text element to a container.
 */
export function badge(box: Box, label: string, fontSize = 14): [ExcalidrawRectangleElement, ExcalidrawTextElement] {
  const textId = crypto.randomUUID();
  const rect = rectangle(box, { boundElements: [{ id: textId, type: "text" }] });
  const label_ = {
    ...text({
      x: box.x,
      y: box.y + box.h / 2 - fontSize * 0.6,
      text: label,
      fontSize,
      align: "center",
      verticalAlign: "middle",
      width: box.w,
      containerId: rect.id,
    }),
    id: textId,
  };
  return [rect, label_];
}

/**
 * Rectangle + title + optional body, GROUPED (shared `groupIds`) rather than
 * bound — because a title and a body are two different font sizes, which
 * bound-text cannot express. Grouping is what makes Excalidraw move all three
 * together when the user drags any one of them.
 *
 * Box height auto-grows to fit the text instead of a fixed size.
 */
export function box(
  b: Box,
  title: string,
  body?: string,
  opts: { titleSize?: number; bodySize?: number; textColor?: string; padding?: number } = {},
): [ExcalidrawRectangleElement, ExcalidrawTextElement, ...ExcalidrawTextElement[]] {
  const titleSize = opts.titleSize ?? 15;
  const bodySize = opts.bodySize ?? 12;
  const pad = opts.padding ?? 14;

  const titleLines = title.split("\n").length;
  const bodyLines = body ? body.split("\n").length : 0;
  const neededH =
    pad * 2 + titleLines * titleSize * 1.4 + (bodyLines ? bodyLines * bodySize * 1.5 + 6 : 0);
  const h = Math.max(b.h, neededH);

  const groupId = crypto.randomUUID();
  const rect = rectangle({ ...b, h }, { groupIds: [groupId] });
  const titleEl = text({
    x: b.x + pad,
    y: b.y + pad,
    text: title,
    fontSize: titleSize,
    color: opts.textColor ?? "#12141f",
    width: b.w - pad * 2,
    groupIds: [groupId],
  });
  const bodyEl = body
    ? text({
        x: b.x + pad,
        y: b.y + pad + titleLines * titleSize * 1.4,
        text: body,
        fontSize: bodySize,
        color: opts.textColor ?? "#374151",
        width: b.w - pad * 2,
        groupIds: [groupId],
      })
    : null;

  return bodyEl ? [rect, titleEl, bodyEl] : [rect, titleEl];
}

export interface Point {
  x: number;
  y: number;
}

export function arrow(
  from: Point,
  to: Point,
  opts: { color?: string; strokeWidth?: number; roughness?: number } = {},
): ExcalidrawArrowElement {
  return {
    ...baseFields(),
    id: crypto.randomUUID(),
    type: "arrow",
    x: from.x,
    y: from.y,
    width: to.x - from.x,
    height: to.y - from.y,
    strokeColor: opts.color ?? "#12141f",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: opts.strokeWidth ?? 2,
    strokeStyle: "solid",
    roughness: opts.roughness ?? 1,
    roundness: { type: 2 },
    points: [
      [0, 0],
      [to.x - from.x, to.y - from.y],
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: "arrow",
    elbowed: false,
  };
}

/**
 * A previously uploaded board file, placed on the canvas. `fileId` must
 * already exist as a `board_files` row (see the icon-bank note in SKILL.md) —
 * this only places it, it does not upload anything.
 */
export function image(
  b: { x: number; y: number; w: number; h: number },
  fileId: string,
): ExcalidrawImageElement {
  return {
    ...baseFields(),
    id: crypto.randomUUID(),
    type: "image",
    x: b.x,
    y: b.y,
    width: b.w,
    height: b.h,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    roundness: null,
    // Branded string type with no runtime meaning — see the lineHeight note.
    fileId: fileId as FileId,
    scale: [1, 1],
    status: "saved",
    crop: null,
    groupIds: [],
  };
}

/**
 * The base fields Excalidraw's own code reads unconditionally (e.g.
 * `element.groupIds.length` during reconciliation) — a build-time check
 * (`tsc`, now that `.claude/**\/*.ts` is in tsconfig's `include`) already
 * catches a builder that omits one of these, but this is the runtime backstop
 * for anything that reaches `write-board.ts` without going through a builder
 * above — a hand-edited scene file, for instance.
 */
const REQUIRED_BASE_KEYS = [
  "id",
  "x",
  "y",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roundness",
  "roughness",
  "opacity",
  "width",
  "height",
  "angle",
  "seed",
  "version",
  "versionNonce",
  "index",
  "isDeleted",
  "groupIds",
  "frameId",
  "boundElements",
  "updated",
  "link",
  "locked",
] as const;

export function assertWellFormed(el: Record<string, unknown>): void {
  for (const key of REQUIRED_BASE_KEYS) {
    if (!(key in el)) {
      throw new Error(`Element "${el.id}" (${el.type}) is missing required field "${key}".`);
    }
  }
  if (!Array.isArray(el.groupIds)) {
    throw new Error(`Element "${el.id}" (${el.type}) has a non-array groupIds.`);
  }
  if (el.boundElements !== null && !Array.isArray(el.boundElements)) {
    throw new Error(`Element "${el.id}" (${el.type}) has a boundElements that is neither null nor an array.`);
  }
}
