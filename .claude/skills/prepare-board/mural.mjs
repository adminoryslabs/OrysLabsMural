#!/usr/bin/env node
/**
 * Cwd-independent entry point for the prepare-board skill.
 *
 * The read/write scripts import repo-internal modules (`@/lib/...`) and
 * resolve `node_modules` plus the tsconfig `paths` from the Mural repo root,
 * so they cannot run from an arbitrary working directory. This wrapper removes
 * that constraint: it locates the repo, switches to it, and runs the existing
 * scripts with the repo's own tsx. Nothing is vendored — the repo stays the
 * single source of truth.
 *
 * Usage (from anywhere):
 *   node mural.mjs catalog                    # list the icon catalog
 *   node mural.mjs read  --board <id>
 *   node mural.mjs write --board <id> --file <scene.json>
 *
 * The `--file` path is resolved against the caller's cwd before switching to
 * the repo, so a relative scene path keeps working. Environment comes from the
 * repo's `.env` plus the process environment — same as running the scripts
 * from the repo root.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT =
  process.env.MURAL_REPO_PATH ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const ACTIONS = {
  read: "read-board.ts",
  write: "write-board.ts",
};

function fail(message) {
  console.error(`mural: ${message}`);
  process.exit(1);
}

/** Minimal dotenv reader — enough to resolve the agent vars without dotenv. */
function loadDotenv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

function repoEnv() {
  return { ...loadDotenv(resolve(REPO_ROOT, ".env")), ...process.env };
}

async function listCatalog() {
  const env = repoEnv();
  const appUrl = env.MURAL_AGENT_APP_URL;
  const token = env.MURAL_AGENT_SESSION_TOKEN;
  if (!appUrl || !token) {
    fail(
      "catalog needs MURAL_AGENT_APP_URL and MURAL_AGENT_SESSION_TOKEN (repo .env or environment). See SKILL.md Setup.",
    );
  }
  const response = await fetch(`${appUrl}/api/icons`, {
    headers: { Cookie: `mural_session=${token}` },
  });
  if (!response.ok) {
    fail(`icon catalog fetch failed: HTTP ${response.status}`);
  }
  console.log(await response.text());
}

if (!existsSync(REPO_ROOT)) {
  fail(
    `repo not found at ${REPO_ROOT}. If the checkout lives elsewhere, set MURAL_REPO_PATH to its absolute path.`,
  );
}

const [action, ...rest] = process.argv.slice(2);

if (action === "catalog") {
  await listCatalog();
  process.exit(0);
}

const script = ACTIONS[action];
if (!script) {
  console.error(
    "Usage: node mural.mjs <read|write|catalog> [--board <id>] [--file <scene.json>]",
  );
  process.exit(2);
}

const fileIndex = rest.indexOf("--file");
if (fileIndex >= 0) {
  rest[fileIndex + 1] = resolve(process.cwd(), rest[fileIndex + 1]);
}

const tsxBin = resolve(
  REPO_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);
if (!existsSync(tsxBin)) {
  fail(
    `tsx is not installed in the repo (${tsxBin}). Run \`npm install\` inside ${REPO_ROOT}.`,
  );
}

const scriptPath = resolve(
  REPO_ROOT,
  ".claude",
  "skills",
  "prepare-board",
  "scripts",
  script,
);

const args = [scriptPath, ...rest].map((arg) =>
  process.platform === "win32" && /\s/.test(arg) ? `"${arg}"` : arg,
);

const child = spawn(tsxBin, args, {
  cwd: REPO_ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 1));