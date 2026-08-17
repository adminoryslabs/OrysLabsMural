/**
 * Ensures a catalog icon's bytes exist on a board before an `image` shape
 * referencing it is written.
 *
 * The browser tool never needs this: `syncFiles` in `board-canvas-scene.tsx`
 * runs continuously and uploads a file the moment an element references it
 * and the server does not have it yet. This process has no such loop — it
 * connects, writes one batch, and exits — so it does the check-then-upload
 * itself, once, before opening the collaboration socket at all. `board_files`'
 * `(boardId, fileId)` primary key with `onConflictDoNothing` (see
 * `lib/boards/files.ts`) is what makes a redundant upload harmless, so the
 * check is an optimisation, not a correctness requirement.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ICON_CATALOG } from "@/lib/collab/icon-tool";

const PUBLIC_ICONS_DIR = join(process.cwd(), "public", "icons");

/**
 * Uploads every catalog icon in `fileIds` that this board does not already
 * hold. A `fileId` outside the catalog is silently skipped — this only knows
 * how to source bytes for icons shipped under `public/icons/`; anything else
 * was either uploaded some other way already, or the write will fail on the
 * server the same way it always has for an unknown `fileId`.
 */
export async function ensureCatalogIconsUploaded(
  appUrl: string,
  boardId: string,
  fileIds: ReadonlySet<string>,
  cookie: string,
): Promise<void> {
  for (const fileId of fileIds) {
    const icon = ICON_CATALOG.find((entry) => entry.fileId === fileId);
    if (!icon) continue;

    const url = `${appUrl}/api/boards/${encodeURIComponent(boardId)}/files/${encodeURIComponent(fileId)}`;
    const head = await fetch(url, { method: "HEAD", headers: { Cookie: cookie } });
    if (head.ok) continue;

    const bytes = await readFile(join(PUBLIC_ICONS_DIR, `${icon.name}.png`));
    const form = new FormData();
    form.append("fileId", fileId);
    form.append("file", new Blob([bytes], { type: "image/png" }), fileId);

    const upload = await fetch(`${appUrl}/api/boards/${encodeURIComponent(boardId)}/files`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: form,
    });
    if (!upload.ok) {
      throw new Error(
        `Failed to upload icon "${icon.name}" (fileId ${fileId}) to board ${boardId}: HTTP ${upload.status}`,
      );
    }
  }
}
