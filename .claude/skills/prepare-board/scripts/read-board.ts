/**
 * Prints a board's current elements as JSON, trimmed to what matters for
 * reasoning about layout (drops `seed`/`versionNonce`/`index`/`updated` —
 * reconciliation bookkeeping the agent never needs to read).
 *
 * Usage:
 *   npx tsx .claude/skills/prepare-board/scripts/read-board.ts --board <id>
 */
import "dotenv/config";
import { WebSocket } from "ws";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session-cookie";
import { BoardSession } from "@/lib/collab/board-session";

const ELEMENTS_KEY = "elements";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Run scripts/mint-agent-token.ts once, see SKILL.md.`);
  }
  return value;
}

function parseArgs(argv: string[]): { board: string } {
  const i = argv.indexOf("--board");
  const board = i >= 0 ? argv[i + 1] : undefined;
  if (!board) {
    throw new Error("Usage: read-board.ts --board <id>");
  }
  return { board };
}

function summarize(el: ExcalidrawElement) {
  const common = {
    id: el.id,
    type: el.type,
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    strokeColor: el.strokeColor,
    backgroundColor: el.backgroundColor,
    groupIds: el.groupIds,
  };
  if (el.type === "text") {
    return { ...common, text: el.text, fontSize: el.fontSize, containerId: el.containerId };
  }
  if (el.type === "rectangle" || el.type === "ellipse" || el.type === "diamond") {
    return { ...common, boundElements: el.boundElements };
  }
  return common;
}

async function main(): Promise<void> {
  const { board: boardId } = parseArgs(process.argv.slice(2));
  const serverUrl = requiredEnv("MURAL_AGENT_YJS_URL");
  const token = requiredEnv("MURAL_AGENT_SESSION_TOKEN");
  const cookie = `${SESSION_COOKIE_NAME}=${token}`;

  const CookieWebSocket = class extends WebSocket {
    constructor(address: string, protocols?: string | string[]) {
      super(address, protocols, { headers: { Cookie: cookie } });
    }
  } as unknown as typeof globalThis.WebSocket;

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
      console.error(`The server refused this connection: ${reason}`);
    },
  });

  await synced;

  const elements = [...session.document.getMap<ExcalidrawElement>(ELEMENTS_KEY).values()].filter(
    (el) => !el.isDeleted,
  );

  session.destroy();

  console.log(JSON.stringify(elements.map(summarize), null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
