/**
 * Writes a scene (a JSON file of `Shape`s, see skeleton.ts) onto a live board.
 *
 * Connects the same way a browser tab does: `BoardSession` over the real
 * y-websocket protocol, with the agent's session cookie on the handshake. The
 * server re-reads board authority on its own — a frozen board rejects this
 * exactly like it would reject a student, no special case exists for us.
 *
 * Needs only MURAL_AGENT_YJS_URL and MURAL_AGENT_SESSION_TOKEN — no database
 * access. Run `scripts/mint-agent-token.ts` once (from the project root, with
 * DATABASE_URL set) to obtain the token.
 *
 * Usage:
 *   npx tsx .claude/skills/prepare-board/scripts/write-board.ts --board <id> --file scene.json
 */
import { readFileSync } from "node:fs";
import "dotenv/config";
import { WebSocket } from "ws";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session-cookie";
import { BoardSession } from "@/lib/collab/board-session";
import { expandScene, type Shape } from "./skeleton";

const ELEMENTS_KEY = "elements";
const LOCAL_ORIGIN = "agent";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Run scripts/mint-agent-token.ts once, see SKILL.md.`);
  }
  return value;
}

function parseArgs(argv: string[]): { board: string; file: string } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const board = get("--board");
  const file = get("--file");
  if (!board || !file) {
    throw new Error("Usage: write-board.ts --board <id> --file <scene.json>");
  }
  return { board, file };
}

async function main(): Promise<void> {
  const { board: boardId, file } = parseArgs(process.argv.slice(2));
  const serverUrl = requiredEnv("MURAL_AGENT_YJS_URL");
  const token = requiredEnv("MURAL_AGENT_SESSION_TOKEN");
  const cookie = `${SESSION_COOKIE_NAME}=${token}`;

  const shapes: Shape[] = JSON.parse(readFileSync(file, "utf8"));
  const scene = expandScene(shapes);

  const CookieWebSocket = class extends WebSocket {
    constructor(address: string, protocols?: string | string[]) {
      super(address, protocols, { headers: { Cookie: cookie } });
    }
  } as unknown as typeof globalThis.WebSocket;

  let denied: string | null = null;
  let resolveSynced: () => void;
  const synced = new Promise<void>((resolve) => {
    resolveSynced = resolve;
  });

  const session = new BoardSession({
    serverUrl,
    boardId,
    identity: { id: "agent", name: "🤖 OrysLabs Agent", color: "#ec4899" },
    WebSocketPolyfill: CookieWebSocket,
    onBind: () => {},
    onSync: (isSynced) => {
      if (isSynced) resolveSynced();
    },
    onDenied: (reason) => {
      denied = reason;
    },
  });

  await synced;

  const doc = session.document;
  const map = doc.getMap<Record<string, unknown>>(ELEMENTS_KEY);
  doc.transact(() => {
    for (const el of scene) {
      map.set(el.id, el as unknown as Record<string, unknown>);
    }
  }, LOCAL_ORIGIN);

  // Give the update a moment to reach the server before disconnecting.
  await new Promise((r) => setTimeout(r, 1000));

  session.destroy();

  if (denied) {
    console.error(`The server refused this write: ${denied}`);
    process.exit(1);
  }

  console.log(`Wrote ${scene.length} elements to board ${boardId}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
