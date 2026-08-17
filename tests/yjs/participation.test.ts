import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeStaleBoardSessions,
  getBoardParticipation,
} from "@/lib/participation/queries";
import { boardSessions } from "@/lib/db/schema";
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

async function sessionsFor(boardId: string) {
  return testDb
    .select()
    .from(boardSessions)
    .where(eq(boardSessions.boardId, boardId));
}

beforeEach(async () => {
  await resetDatabase();
  server = await startTestServer();
});

afterEach(async () => {
  for (const client of openClients.splice(0)) client.destroy();
  await server.close().catch(() => {});
});

describe("board session lifecycle", () => {
  it("opens a session row when a client connects", async () => {
    const { student, board } = await seedBoardWithMember();
    const client = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(client);

    await waitUntil(async () => (await sessionsFor(board.id)).length === 1, {
      label: "the session row",
    });
    const [row] = await sessionsFor(board.id);
    expect(row?.userId).toBe(student.id);
    expect(row?.disconnectedAt).toBeNull();
    expect(row?.connectionId).toBeTruthy();
  });

  it("heartbeats last_seen_at while the connection is idle", async () => {
    const { student, board } = await seedBoardWithMember();
    const client = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(client);
    await waitUntil(async () => (await sessionsFor(board.id)).length === 1, {
      label: "the session row",
    });

    const [initial] = await sessionsFor(board.id);
    const initialSeen = initial!.lastSeenAt.getTime();

    // No edits at all: the heartbeat alone must keep the row fresh, which is
    // what bounds an abandoned tab instead of letting it accrue time forever.
    await waitUntil(
      async () => {
        const [row] = await sessionsFor(board.id);
        return !!row && row.lastSeenAt.getTime() > initialSeen;
      },
      { label: "the heartbeat to advance last_seen_at" },
    );
  });

  it("attributes edits to the connection that made them", async () => {
    const { teacher, student, board } = await seedBoardWithMember();
    const writer = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    const watcher = track(
      createClient(server, board.id, await cookieFor(teacher.id)),
    );
    await waitForSync(writer);
    await waitForSync(watcher);

    for (let i = 0; i < 3; i++) {
      writer.shapes.set(`shape-${i}`, { id: `shape-${i}` });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await waitUntil(
      async () => {
        const rows = await sessionsFor(board.id);
        const studentRow = rows.find((row) => row.userId === student.id);
        return (studentRow?.editCount ?? 0) >= 3;
      },
      { label: "edits to be attributed to the student" },
    );

    const rows = await sessionsFor(board.id);
    const teacherRow = rows.find((row) => row.userId === teacher.id);
    // The teacher only observed; relayed updates are not their edits.
    expect(teacherRow?.editCount).toBe(0);
  });

  it("does not count a rejected update as an edit", async () => {
    const { student, board } = await seedBoardWithMember("frozen");
    const client = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(client);
    await waitUntil(async () => (await sessionsFor(board.id)).length === 1, {
      label: "the session row",
    });

    client.shapes.set("forbidden", { id: "forbidden" });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const [row] = await sessionsFor(board.id);
    expect(row?.editCount).toBe(0);
  });

  it("closes the session when the client disconnects", async () => {
    const { student, board } = await seedBoardWithMember();
    const client = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(client);
    await waitUntil(async () => (await sessionsFor(board.id)).length === 1, {
      label: "the session row",
    });

    client.destroy();
    openClients.length = 0;

    await waitUntil(
      async () => {
        const [row] = await sessionsFor(board.id);
        return !!row?.disconnectedAt;
      },
      { label: "the session to be closed" },
    );
  });

  it("closes every open session when the server shuts down", async () => {
    const { teacher, student, board } = await seedBoardWithMember();
    const a = track(createClient(server, board.id, await cookieFor(student.id)));
    const b = track(createClient(server, board.id, await cookieFor(teacher.id)));
    await waitForSync(a);
    await waitForSync(b);
    await waitUntil(async () => (await sessionsFor(board.id)).length === 2, {
      label: "both session rows",
    });

    await server.close();

    const rows = await sessionsFor(board.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.disconnectedAt !== null)).toBe(true);
  });

  it("feeds the instructor's participation report", async () => {
    const { student, board } = await seedBoardWithMember();
    const client = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(client);
    client.shapes.set("shape", { id: "shape" });

    await waitUntil(
      async () => {
        const rows = await getBoardParticipation(testDb, board.id);
        return rows.some((row) => row.userId === student.id && row.totalEdits > 0);
      },
      { label: "the participation report" },
    );

    const rows = await getBoardParticipation(testDb, board.id);
    const entry = rows.find((row) => row.userId === student.id);
    expect(entry?.displayName).toBe("Ada Lovelace");
    expect(entry?.sessionCount).toBe(1);
  });
});

describe("stale session reaper", () => {
  it("closes sessions whose heartbeat went silent", async () => {
    // A live heartbeat (the default 50ms test interval) unconditionally sets
    // lastSeenAt to the real "now" — see recordBoardActivity. Racing that
    // against the backdate below is what made this test flaky in CI only: a
    // busier runner gives one more heartbeat tick time to land between the
    // UPDATE and closeStaleBoardSessions, undoing the simulated silence.
    await server.close();
    server = await startTestServer({ heartbeatIntervalMs: 100_000 });

    const { student, board } = await seedBoardWithMember();
    const client = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(client);
    await waitUntil(async () => (await sessionsFor(board.id)).length === 1, {
      label: "the session row",
    });

    const [row] = await sessionsFor(board.id);
    // Simulate a tab that died 10 minutes ago without a clean close.
    const silentSince = new Date(Date.now() - 10 * 60 * 1000);
    await testDb
      .update(boardSessions)
      .set({ lastSeenAt: silentSince, connectedAt: silentSince })
      .where(eq(boardSessions.id, row!.id));

    const closed = await closeStaleBoardSessions(testDb, {
      staleAfterSeconds: 120,
    });

    expect(closed).toBe(1);
    const [reaped] = await sessionsFor(board.id);
    // The disconnect is dated at the last heartbeat, not at "now".
    expect(reaped?.disconnectedAt?.getTime()).toBe(silentSince.getTime());
  });

  it("runs the reaper on its own interval when one is configured", async () => {
    await server.close();
    server = await startTestServer({
      reaperIntervalMs: 60,
      staleAfterSeconds: 1,
      heartbeatIntervalMs: 100_000, // never heartbeats during this test
    });

    const { student, board } = await seedBoardWithMember();
    const client = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(client);
    await waitUntil(async () => (await sessionsFor(board.id)).length === 1, {
      label: "the session row",
    });

    await waitUntil(
      async () => {
        const [row] = await sessionsFor(board.id);
        return !!row?.disconnectedAt;
      },
      { timeoutMs: 8000, label: "the reaper to close the silent session" },
    );
  });
});
