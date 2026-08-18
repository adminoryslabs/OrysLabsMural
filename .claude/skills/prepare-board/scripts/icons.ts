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
 *
 * The catalog itself is the app's global icon bank (`/api/icons`, backed by
 * `icon_catalog` — see `lib/icons/`), not a local file anymore: a teacher can
 * add an icon from `/teacher/icons` without touching this repo, so this
 * script has to ask the running app what exists rather than reading
 * `public/icons/` off disk.
 */

/**
 * Uploads every catalog icon in `fileIds` that this board does not already
 * hold. A `fileId` outside the catalog is silently skipped — this only knows
 * how to source bytes for icons the app's catalog actually has; anything else
 * was either uploaded some other way already, or the write will fail on the
 * server the same way it always has for an unknown `fileId`.
 */
export async function ensureCatalogIconsUploaded(
  appUrl: string,
  boardId: string,
  fileIds: ReadonlySet<string>,
  cookie: string,
): Promise<void> {
  if (fileIds.size === 0) return;

  const catalogResponse = await fetch(`${appUrl}/api/icons`, {
    headers: { Cookie: cookie },
  });
  if (!catalogResponse.ok) {
    throw new Error(
      `Failed to fetch the icon catalog from ${appUrl}/api/icons: HTTP ${catalogResponse.status}`,
    );
  }
  const catalog = (await catalogResponse.json()) as Array<{ fileId: string }>;
  const knownFileIds = new Set(catalog.map((entry) => entry.fileId));

  for (const fileId of fileIds) {
    if (!knownFileIds.has(fileId)) continue;

    const boardFileUrl = `${appUrl}/api/boards/${encodeURIComponent(boardId)}/files/${encodeURIComponent(fileId)}`;
    const head = await fetch(boardFileUrl, {
      method: "HEAD",
      headers: { Cookie: cookie },
    });
    if (head.ok) continue;

    const bytesResponse = await fetch(
      `${appUrl}/api/icons/${encodeURIComponent(fileId)}`,
      { headers: { Cookie: cookie } },
    );
    if (!bytesResponse.ok) {
      throw new Error(
        `Failed to fetch icon bytes for "${fileId}": HTTP ${bytesResponse.status}`,
      );
    }
    const mimeType =
      bytesResponse.headers.get("content-type") ?? "image/png";
    const bytes = new Uint8Array(await bytesResponse.arrayBuffer());

    const form = new FormData();
    form.append("fileId", fileId);
    form.append("file", new Blob([bytes], { type: mimeType }), fileId);

    const upload = await fetch(
      `${appUrl}/api/boards/${encodeURIComponent(boardId)}/files`,
      { method: "POST", headers: { Cookie: cookie }, body: form },
    );
    if (!upload.ok) {
      throw new Error(
        `Failed to upload icon (fileId ${fileId}) to board ${boardId}: HTTP ${upload.status}`,
      );
    }
  }
}
