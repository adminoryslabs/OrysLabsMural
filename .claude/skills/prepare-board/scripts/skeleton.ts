/**
 * The scene description an agent writes: a flat JSON array of shapes,
 * simplified the same way Excalidraw's own `ExcalidrawElementSkeleton` is —
 * no `seed`/`version`/`versionNonce`/binding bookkeeping. `expandShape` fills
 * that in via `elements.ts`. See SKILL.md for the full schema and examples.
 */
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { arrow, badge, box, image, rectangle, text, type Box, type Point } from "./elements";

export type Shape =
  | ({ type: "box"; title: string; body?: string; titleSize?: number; bodySize?: number; textColor?: string } & Box)
  | ({ type: "badge"; label: string; fontSize?: number } & Box)
  | ({ type: "rectangle" } & Box)
  | ({ type: "text" } & Omit<Parameters<typeof text>[0], never>)
  | { type: "arrow"; from: Point; to: Point; color?: string; strokeWidth?: number }
  | { type: "image"; x: number; y: number; w: number; h: number; fileId: string };

export function expandShape(shape: Shape): ExcalidrawElement[] {
  switch (shape.type) {
    case "box":
      return box(shape, shape.title, shape.body, {
        titleSize: shape.titleSize,
        bodySize: shape.bodySize,
        textColor: shape.textColor,
      });
    case "badge":
      return badge(shape, shape.label, shape.fontSize);
    case "rectangle":
      return [rectangle(shape)];
    case "text":
      return [text(shape)];
    case "arrow":
      return [arrow(shape.from, shape.to, { color: shape.color, strokeWidth: shape.strokeWidth })];
    case "image":
      return [image(shape, shape.fileId)];
  }
}

export function expandScene(shapes: Shape[]): ExcalidrawElement[] {
  return shapes.flatMap(expandShape);
}
