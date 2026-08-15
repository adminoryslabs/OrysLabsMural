import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeBoardMember, setBoardStatus } from "@/lib/boards/queries";
import { boardSessions } from "@/lib/db/schema";
import { encodeBoardStatus } from "@/lib/collab/status-frame";
import { encodeUpdate } from "@/yjs-server/protocol";
import type { YjsServer } from "@/yjs-server/server";
import * as Y from "yjs";
import { resetDatabase, testDb } from "../setup/db";
import { seedClassroom } from "../setup/fixtures";
import {
  cookieFor,
  createClient,
  expectNeverArrives,
  rawConnect,
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

async function countSessions(userId: string): Promise<number> {
  const rows = await testDb
    .select({ id: boardSessions.id })
    .from(boardSessions)
    .where(eq(boardSessions.userId, userId));
  return rows.length;
}

beforeEach(async () => {
  await resetDatabase();
  server = await startTestServer();
});

afterEach(async () => {
  for (const client of openClients.splice(0)) client.destroy();
  await server.close();
});

describe("the server states the board status on connect", () => {
  it("tells a member it may write on an active board", async () => {
    const { student, board } = await seedClassroom("active");
    const client = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(client);

    await waitUntil(() => client.authority !== null, {
      label: "the initial board status",
    });
    expect(client.authority).toEqual({ status: "active", canWrite: true });
  });

  it("tells a student it may not write on a readonly board", async () => {
    const { student, board } = await seedClassroom("readonly");
    const client = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(client);

    await waitUntil(() => client.authority !== null, {
      label: "the initial board status",
    });
    expect(client.authority).toEqual({ status: "readonly", canWrite: false });
  });

  it("tells the owning teacher it may not write on a frozen board", async () => {
    const { teacher, board } = await seedClassroom("frozen");
    const client = track(
      createClient(server, board.id, await cookieFor(teacher.id)),
    );
    await waitForSync(client);

    await waitUntil(() => client.authority !== null, {
      label: "the initial board status",
    });
    expect(client.authority).toEqual({ status: "frozen", canWrite: false });
  });
});

describe("a status change reaches an already-connected client", () => {
  it("pushes a freeze without the client doing anything at all", async () => {
    const { student, board } = await seedClassroom("active");
    const client = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(client);
    await waitUntil(() => client.authority?.canWrite === true, {
      label: "the initial board status",
    });
    const documentBefore = client.documentId;

    // The teacher freezes the board from the panel. The client is idle: it
    // sends no frame that the server could piggyback an answer on.
    await setBoardStatus(testDb, board.id, "frozen");

    await waitUntil(() => client.authority?.status === "frozen", {
      label: "the freeze to reach the idle client",
    });
    expect(client.authority).toEqual({ status: "frozen", canWrite: false });
    // Nothing was rebuilt: same document, same socket, no refusal.
    expect(client.documentId).toBe(documentBefore);
    expect(client.denials).toBe(0);
    expect(client.connectionEvents).not.toContain("disconnected");
  });

  it("pushes the unfreeze to a client that has stopped sending write frames", async () => {
    const { teacher, student, board } = await seedClassroom("active");
    const writer = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    const reader = track(
      createClient(server, board.id, await cookieFor(teacher.id)),
    );
    await waitForSync(writer);
    await waitForSync(reader);
    await waitUntil(() => writer.authority?.canWrite === true, {
      label: "the initial board status",
    });

    await setBoardStatus(testDb, board.id, "frozen");
    await waitUntil(() => writer.authority?.canWrite === false, {
      label: "the freeze",
    });

    // THE POINT OF THE WHOLE FEATURE: from here on the client is silent. It
    // sends no update, so the per-write-frame authority check can never run
    // again and could never notice the unfreeze on its own.
    const framesSentBefore = writer.denials;
    const documentBefore = writer.documentId;

    await setBoardStatus(testDb, board.id, "active");

    await waitUntil(() => writer.authority?.canWrite === true, {
      label: "the unfreeze to reach the silent client",
    });
    expect(writer.authority).toEqual({ status: "active", canWrite: true });
    expect(writer.denials).toBe(framesSentBefore);
    expect(writer.documentId).toBe(documentBefore);

    // And the restored permission is real, not just a label.
    writer.shapes.set("after-thaw", { id: "after-thaw" });
    await waitUntil(() => reader.shapes.has("after-thaw"), {
      label: "writing to resume after the pushed unfreeze",
    });
  });

  it("restores a client that was actually refused, without a reload", async () => {
    const { teacher, student, board } = await seedClassroom("active");
    const writer = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    const reader = track(
      createClient(server, board.id, await cookieFor(teacher.id)),
    );
    await waitForSync(writer);
    await waitForSync(reader);

    // Freeze and refuse a write, so the client is in the latched "refused"
    // state a student hit in class.
    await setBoardStatus(testDb, board.id, "frozen");
    await waitUntil(() => writer.authority?.canWrite === false, {
      label: "the freeze",
    });
    writer.shapes.set("refused", { id: "refused" });
    await waitUntil(() => writer.denials > 0, {
      label: "the write to be refused",
    });
    await expectNeverArrives(() => reader.shapes.has("refused"));

    const denialsAfterRefusal = writer.denials;
    await setBoardStatus(testDb, board.id, "active");

    await waitUntil(() => writer.authority?.canWrite === true, {
      label: "the unfreeze to reach the refused client",
    });
    expect(writer.denials).toBe(denialsAfterRefusal);

    writer.shapes.set("after-thaw", { id: "after-thaw" });
    await waitUntil(() => reader.shapes.has("after-thaw"), {
      label: "the previously refused client to write again",
    });
  });

  it("does not open a second participation row for a status change", async () => {
    const { student, board } = await seedClassroom("active");
    const client = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(client);
    await waitUntil(() => client.authority?.canWrite === true, {
      label: "the initial board status",
    });
    expect(await countSessions(student.id)).toBe(1);

    await setBoardStatus(testDb, board.id, "frozen");
    await waitUntil(() => client.authority?.canWrite === false, {
      label: "the freeze",
    });
    await setBoardStatus(testDb, board.id, "active");
    await waitUntil(() => client.authority?.canWrite === true, {
      label: "the unfreeze",
    });

    // One connection, one row: pushing a status must never reconnect anyone.
    expect(await countSessions(student.id)).toBe(1);
  });

  it("closes a client whose membership was revoked, as not found", async () => {
    const { student, board } = await seedClassroom("active");
    const client = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(client);
    await waitUntil(() => client.authority?.canWrite === true, {
      label: "the initial board status",
    });

    await removeBoardMember(testDb, board.id, student.id);
    // The revocation is noticed on the next status re-evaluation.
    await setBoardStatus(testDb, board.id, "readonly");

    await waitUntil(() => client.connectionEvents.includes("disconnected"), {
      label: "the revoked client to be dropped",
    });
  });
});

describe("the pushed status is a hint, never the authority", () => {
  it("ignores a forged status frame sent by a client", async () => {
    const { teacher, student, board } = await seedClassroom("readonly");
    const reader = track(
      createClient(server, board.id, await cookieFor(teacher.id)),
    );
    await waitForSync(reader);

    const hostile = rawConnect(
      server,
      `/${board.id}`,
      await cookieFor(student.id),
    );
    await hostile.opened;

    // The client claims, on the wire, that it may write.
    hostile.socket.send(
      Buffer.from(encodeBoardStatus({ status: "active", canWrite: true })),
    );

    const doc = new Y.Doc();
    doc.getMap("shapes").set("forged", { id: "forged" });
    hostile.socket.send(Buffer.from(encodeUpdate(Y.encodeStateAsUpdate(doc))));

    await expectNeverArrives(() => reader.shapes.has("forged"));

    // The server is unharmed: a legitimate write still flows.
    reader.shapes.set("teacher-note", { id: "teacher-note" });
    await waitUntil(() => server.connectionCount() >= 2, {
      label: "both connections to be live",
    });
    hostile.socket.close();
    doc.destroy();
  });

  it("still refuses a client that ignores the pushed read-only status", async () => {
    const { teacher, student, board } = await seedClassroom("readonly");
    const writer = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    const reader = track(
      createClient(server, board.id, await cookieFor(teacher.id)),
    );
    await waitForSync(writer);
    await waitForSync(reader);
    await waitUntil(() => writer.authority?.canWrite === false, {
      label: "the read-only status",
    });

    // The hint said no. This client writes anyway.
    writer.shapes.set("ignored-the-hint", { id: "ignored-the-hint" });

    await expectNeverArrives(() => reader.shapes.has("ignored-the-hint"));
    await waitUntil(() => writer.denials > 0, {
      label: "the server to refuse the write on its own",
    });
  });
});
