/**
 * ICONS — the pure half.
 *
 * A doodle-style icon dropped on the canvas as an `image` element. Unlike a
 * sticky note there is no `convertToExcalidrawElements` step: an image
 * element is flat JSON (see `image()` in `lib/collab/elements.ts`), so this
 * module only needs to say where the next one goes — the placement math
 * mirrors `sticky-note.ts` on purpose, so the two tools feel like the same
 * family of button.
 *
 * The catalog itself now lives in the database (`/api/icons`), not here — a
 * teacher can add an icon from `/teacher/icons` without a deploy. This module
 * stays pure and DB-free: `findIcon` takes the fetched catalog as a
 * parameter rather than reaching out for it, the same way every other pure
 * module in `lib/collab` takes its inputs as arguments instead of fetching
 * them itself.
 *
 * Nothing here touches Excalidraw, the DOM or the network, so it is testable
 * in plain Node. The viewport-centre helper lives in `sticky-note.ts` and is
 * generic enough to reuse as-is — callers import it from there directly
 * rather than this module re-exporting it.
 */

/**
 * Smaller than a sticky note: an icon is an annotation on top of other
 * content, not the primary thing being written.
 */
export const ICON_SIZE = 120;

export interface IconCatalogEntry {
  /** Stable slug, unique across the catalog. */
  name: string;
  /** Accessible label shown in the picker. */
  label: string;
  /** The `icon_catalog`/`board_files` id this icon travels under. */
  fileId: string;
}

/** Where the browser and the agent skill both fetch an icon's bytes from. */
export function iconDownloadUrl(fileId: string): string {
  return `/api/icons/${encodeURIComponent(fileId)}`;
}

/** Catalog lookup by name, over an already-fetched catalog. */
export function findIcon(
  catalog: readonly IconCatalogEntry[],
  name: string,
): IconCatalogEntry | undefined {
  return catalog.find((icon) => icon.name === name);
}

/**
 * Excalidraw positions an element by its top-left corner, so the scene point
 * we want the icon centred on has to be moved half an icon up and left. Same
 * math as `stickyNoteOrigin`, just against `ICON_SIZE`.
 */
export function iconOrigin(centre: { x: number; y: number }): {
  x: number;
  y: number;
} {
  return {
    x: Math.round(centre.x - ICON_SIZE / 2),
    y: Math.round(centre.y - ICON_SIZE / 2),
  };
}
