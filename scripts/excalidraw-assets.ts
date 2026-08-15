import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Copies Excalidraw's font files into `public/`.
 *
 * Without this, Excalidraw falls back to fetching its fonts from a public CDN
 * at runtime. This whiteboard is meant to run on a classroom VPS - and to keep
 * working when the network does not - so the assets are served from the same
 * origin as the app. `window.EXCALIDRAW_ASSET_PATH` points at `/excalidraw/`.
 */

const require = createRequire(import.meta.url);

async function main(): Promise<void> {
  // The package only exports its entry point, so the font directory is located
  // relative to the resolved bundle rather than to package.json.
  const entry = require.resolve("@excalidraw/excalidraw");
  const source = join(dirname(entry), "fonts");
  const destination = join(process.cwd(), "public", "excalidraw", "fonts");

  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });

  console.log(`Copied Excalidraw fonts to ${destination}`);
}

main().catch((error) => {
  console.error("Could not copy the Excalidraw assets.", error);
  process.exit(1);
});
