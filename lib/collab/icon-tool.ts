/**
 * ICONS — the pure half.
 *
 * A doodle-style icon dropped on the canvas as an `image` element. Unlike a
 * sticky note there is no `convertToExcalidrawElements` step: an image
 * element is flat JSON (see `image()` in `lib/collab/elements.ts`), so this
 * module only needs to say which icons exist and where the next one goes —
 * the placement math mirrors `sticky-note.ts` on purpose, so the two tools
 * feel like the same family of button.
 *
 * Nothing here touches Excalidraw or the DOM, so it is testable in plain
 * Node. The viewport-centre helper lives in `sticky-note.ts` and is generic
 * enough to reuse as-is — callers import it from there directly rather than
 * this module re-exporting it.
 */

/**
 * Smaller than a sticky note: an icon is an annotation on top of other
 * content, not the primary thing being written.
 */
export const ICON_SIZE = 120;

export interface IconCatalogEntry {
  /** Stable name, also the PNG's filename stem under `public/icons/`. */
  name: string;
  /** Accessible label shown in the picker. */
  label: string;
  /**
   * The `board_files` id this icon is uploaded under. A fixed catalog name
   * rather than a content hash — `board_files`' `(boardId, fileId)` primary
   * key with `onConflictDoNothing` already makes re-uploading the same id to
   * the same board a safe no-op, so there is no need to hash the bytes.
   */
  fileId: string;
}

function entry(name: string, label: string): IconCatalogEntry {
  return { name, label, fileId: `icon-${name}` };
}

/** The doodle icon bank. Order here is the order the picker's grid shows. */
export const ICON_CATALOG: readonly IconCatalogEntry[] = [
  entry("bulb", "Bulb"),
  entry("calendar", "Calendar"),
  entry("checklist", "Checklist"),
  entry("file", "File"),
  entry("gear", "Gear"),
  entry("lab", "Lab"),
  entry("laptop", "Laptop"),
  entry("padlock", "Padlock"),
  entry("shield", "Shield"),
  entry("user", "User"),
] as const;

/** Where the browser fetches an icon's bytes from — a static asset. */
export function iconUrl(name: string): string {
  return `/icons/${name}.png`;
}

/** Catalog lookup by name. `undefined` when nothing matches. */
export function findIcon(name: string): IconCatalogEntry | undefined {
  return ICON_CATALOG.find((icon) => icon.name === name);
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
