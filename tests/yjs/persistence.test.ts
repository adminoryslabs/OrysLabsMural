import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getBoardById } from "@/lib/boards/queries";
import { getLatestBoardSnapshot } from "@/lib/boards/snapshots";
import { boardSnapshots } from "@/lib/db/schema";
import type { YjsServer } from "@/yjs-server/server";
import { resetDatabase, testDb } from "../setup/db";
import { seedBoardWithMember } from "../setup/fixtures";
import {
  cookieFor,
  createClient,
  startTestServer,
  waitForSync,
  waitUntil,
  type TestClient,
} from "../setup/yjs";

let server: YjsServer;
const openClients: TestClient[] = [];

function track(client: TestClient): TestClient {
  openClients.push(client);
  return client;
}

async function shutdown() {
  for (const client of openClients.splice(0)) client.destroy();
  await server.close();
}

beforeEach(async () => {
  await resetDatabase();
  server = await startTestServer();
});

afterEach(async () => {
  await shutdown().catch(() => {});
});

describe("snapshot persistence", () => {
  it("persists the document after the debounce window", async () => {
    const { student, board } = await seedBoardWithMember();
    const client = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(client);

    client.shapes.set("note", { id: "note", text: "ports and adapters" });

    await waitUntil(
      async () => (await getLatestBoardSnapshot(testDb, board.id)) !== null,
      { label: "a persisted snapshot" },
    );
  });

  it("rehydrates a fresh server from the stored snapshot", async () => {
    const { student, board } = await seedBoardWithMember();
    const cookie = await cookieFor(student.id);

    const first = track(createClient(server, board.id, cookie));
    await waitForSync(first);
    first.shapes.set("note", { id: "note", text: "ports and adapters" });
    await waitUntil(
      async () => (await getLatestBoardSnapshot(testDb, board.id)) !== null,
      { label: "a persisted snapshot" },
    );

    // Full restart: every in-memory room is gone.
    await shutdown();
    server = await startTestServer();
    expect(server.roomCount()).toBe(0);

    const reconnected = track(createClient(server, board.id, cookie));
    await waitForSync(reconnected);
    await waitUntil(() => reconnected.shapes.has("note"), {
      label: "the rehydrated document",
    });
    expect(reconnected.shapes.get("note")).toEqual({
      id: "note",
      text: "ports and adapters",
    });
  });

  it("flushes the document when the last client leaves", async () => {
    // A debounce that can never fire inside this test, so the only way a
    // snapshot can exist at the end is the flush on the last disconnect —
    // which is the thing this test claims to prove.
    await server.close();
    server = await startTestServer({ snapshotDebounceMs: 60_000 });

    const { student, board } = await seedBoardWithMember();
    const cookie = await cookieFor(student.id);

    const client = track(createClient(server, board.id, cookie));
    await waitForSync(client);

    // A witness, because the SERVER must be known to hold the update before
    // anyone disconnects. Setting a shape and destroying in the same tick does
    // not guarantee the provider flushed it to the socket, and when it did not,
    // the room had nothing pending and correctly wrote nothing. That read as a
    // mysterious timeout on CI and never reproduced locally, where the send
    // always won the race.
    const witness = track(createClient(server, board.id, cookie));
    await waitForSync(witness);

    client.shapes.set("late", { id: "late" });
    await waitUntil(() => witness.shapes.has("late"), {
      label: "the server to have the update",
    });

    for (const open of openClients.splice(0)) open.destroy();

    await waitUntil(() => server.roomCount() === 0, {
      label: "the room to be released",
    });
    await waitUntil(
      async () => (await getLatestBoardSnapshot(testDb, board.id)) !== null,
      { label: "the flushed snapshot" },
    );
    const snapshot = await getLatestBoardSnapshot(testDb, board.id);
    expect(snapshot).not.toBeNull();
  });

  it("never persists a rejected update", async () => {
    const { student, board } = await seedBoardWithMember("frozen");
    const client = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(client);

    client.shapes.set("forbidden", { id: "forbidden" });
    await new Promise((resolve) => setTimeout(resolve, 400));

    const snapshot = await getLatestBoardSnapshot(testDb, board.id);
    if (snapshot) {
      // A snapshot may exist from the empty initial document; it must not
      // contain the refused change.
      const doc = new Y.Doc();
      Y.applyUpdate(doc, snapshot.state);
      expect(doc.getMap("shapes").has("forbidden")).toBe(false);
    }
  });

  it("touches boards.updated_at when it persists", async () => {
    const { student, board } = await seedBoardWithMember();
    const before = board.updatedAt.getTime();

    const client = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(client);
    client.shapes.set("note", { id: "note" });

    await waitUntil(
      async () => {
        const row = await getBoardById(testDb, board.id);
        return row !== null && row.updatedAt.getTime() > before;
      },
      { label: "boards.updated_at to move" },
    );
  });

  it("prunes snapshot history to the configured limit", async () => {
    await shutdown();
    server = await startTestServer({ snapshotHistoryLimit: 3 });

    const { student, board } = await seedBoardWithMember();
    const client = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(client);

    for (let i = 0; i < 8; i++) {
      client.shapes.set(`shape-${i}`, { id: `shape-${i}` });
      await new Promise((resolve) => setTimeout(resolve, 90));
    }

    await waitUntil(
      async () => {
        const rows = await testDb.select().from(boardSnapshots);
        return rows.length > 0 && rows.length <= 3;
      },
      { label: "snapshot history to stay bounded" },
    );
  });
});
