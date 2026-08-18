import "dotenv/config";
import { eq } from "drizzle-orm";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDatabase } from "@/lib/db";
import { sniffImageMimeType } from "@/lib/boards/files";
import { IconNameTakenError, saveIconCatalogEntry } from "@/lib/icons/icons";
import { users } from "@/lib/db/schema";

/**
 * One-off migration: seeds `icon_catalog` from whatever PNGs are sitting in
 * `public/icons/` at the moment this runs, then that directory and the
 * hardcoded catalog array in `lib/collab/icon-tool.ts` are retired — the
 * database becomes the only source of truth from here on.
 *
 * Idempotent: re-running it after some icons are already seeded just skips
 * the ones that already exist by name, same as `scripts/seed.ts` skips an
 * existing account rather than erroring.
 *
 *   npx tsx scripts/seed-icon-catalog.ts
 */

const PUBLIC_ICONS_DIR = join(process.cwd(), "public", "icons");

/** "LLM" stays "LLM"; "robot" becomes "Robot". Only a stem already fully
 * uppercase is treated as an acronym worth preserving as-is. */
function labelFor(stem: string): string {
  if (stem === stem.toUpperCase()) return stem;
  return stem[0]!.toUpperCase() + stem.slice(1);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy env.example to .env and start Postgres with `docker compose up -d`.",
    );
  }

  const db = createDatabase(url, 1);

  const [teacher] = await db
    .select()
    .from(users)
    .where(eq(users.role, "teacher"))
    .limit(1);
  if (!teacher) {
    throw new Error(
      "No teacher account exists yet. Run `npm run db:seed` first, then re-run this script.",
    );
  }

  const files = (await readdir(PUBLIC_ICONS_DIR)).filter((name) =>
    name.toLowerCase().endsWith(".png"),
  );

  let seeded = 0;
  let skipped = 0;

  for (const filename of files) {
    const stem = filename.slice(0, -".png".length);
    const name = stem.toLowerCase();
    const label = labelFor(stem);

    const bytes = new Uint8Array(
      await readFile(join(PUBLIC_ICONS_DIR, filename)),
    );
    const mimeType = sniffImageMimeType(bytes);
    if (!mimeType) {
      console.warn(`Skipping ${filename}: not a recognised image format.`);
      continue;
    }

    try {
      await saveIconCatalogEntry(db, {
        name,
        label,
        mimeType,
        bytes,
        createdBy: teacher.id,
      });
      seeded += 1;
      console.log(`Seeded "${name}" (${label}).`);
    } catch (error) {
      if (error instanceof IconNameTakenError) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }

  console.log(`\nDone. Seeded ${seeded} icon(s), left ${skipped} existing untouched.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
