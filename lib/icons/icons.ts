import { eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { iconCatalog, type IconCatalogRow } from "@/lib/db/schema";
import { type AllowedImageMimeType } from "@/lib/boards/files";

/**
 * THE GLOBAL DOODLE ICON BANK — the storage half.
 *
 * Mirrors `lib/boards/files.ts` (same bytea storage, same mime allowlist,
 * reused from there rather than duplicated) but at global scope: one catalog,
 * not one per board. This is the module a teacher's upload, the browser's
 * picker, and the `prepare-board` skill all end up reading through — directly
 * here for the picker page (a server component), over HTTP for everyone else.
 */

/** Slug shape: lowercase, digits, hyphens, 1-64 chars, no leading/trailing hyphen. */
const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

export function isValidIconName(value: unknown): value is string {
  return typeof value === "string" && NAME_PATTERN.test(value);
}

export function fileIdForIconName(name: string): string {
  return `icon-${name}`;
}

export class IconNameTakenError extends Error {
  constructor(name: string) {
    super(`An icon named "${name}" already exists.`);
    this.name = "IconNameTakenError";
  }
}

export interface SaveIconCatalogEntryInput {
  name: string;
  label: string;
  mimeType: AllowedImageMimeType;
  bytes: Uint8Array;
  createdBy: string;
}

/**
 * Inserts one icon. Throws `IconNameTakenError` on a name collision rather
 * than silently keeping the old bytes — unlike `saveBoardFile`'s
 * `onConflictDoNothing`, two different teachers uploading under the same name
 * are not the same picture, so the second one must be told, not swallowed.
 *
 * `onConflictDoNothing().returning()` is what makes this race-safe without a
 * separate existence check first: an empty result means the row that would
 * have been inserted lost the race to a concurrent insert of the same name.
 */
export async function saveIconCatalogEntry(
  db: Database,
  input: SaveIconCatalogEntryInput,
): Promise<IconCatalogRow> {
  const fileId = fileIdForIconName(input.name);
  const bytes = Buffer.from(
    input.bytes.buffer,
    input.bytes.byteOffset,
    input.bytes.byteLength,
  );

  const [row] = await db
    .insert(iconCatalog)
    .values({
      fileId,
      name: input.name,
      label: input.label,
      mimeType: input.mimeType,
      bytes,
      byteSize: bytes.byteLength,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing({ target: iconCatalog.fileId })
    .returning();

  if (!row) throw new IconNameTakenError(input.name);
  return row;
}

export async function getIconByFileId(
  db: Database,
  fileId: string,
): Promise<IconCatalogRow | null> {
  const [row] = await db
    .select()
    .from(iconCatalog)
    .where(eq(iconCatalog.fileId, fileId))
    .limit(1);
  return row ?? null;
}

export interface IconCatalogSummary {
  name: string;
  label: string;
  fileId: string;
}

/** Metadata only — never the bytes. What the picker and the skill both fetch. */
export async function listIconCatalog(
  db: Database,
): Promise<IconCatalogSummary[]> {
  return db
    .select({
      name: iconCatalog.name,
      label: iconCatalog.label,
      fileId: iconCatalog.fileId,
    })
    .from(iconCatalog)
    .orderBy(iconCatalog.createdAt);
}
