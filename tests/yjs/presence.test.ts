import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { YjsServer } from "@/yjs-server/server";
import { resetDatabase } from "../setup/db";
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

beforeEach(async () => {
  await resetDatabase();
  server = await startTestServer();
});

afterEach(async () => {
  for (const client of openClients.splice(0)) client.destroy();
  await server.close();
});

describe("presence", () => {
  it("shows the display name of everyone else on the board", async () => {
    const { teacher, student, board } = await seedBoardWithMember();
    const a = track(
      createClient(server, board.id, await cookieFor(student.id), {
        id: student.id,
        name: "Ada Lovelace",
        color: "#e11d48",
      }),
    );
    const b = track(
      createClient(server, board.id, await cookieFor(teacher.id), {
        id: teacher.id,
        name: "Course Instructor",
        color: "#2563eb",
      }),
    );
    await waitForSync(a);
    await waitForSync(b);

    await waitUntil(() => a.peers().length === 1 && b.peers().length === 1, {
      label: "both clients to see each other",
    });

    expect(a.peers()[0]?.name).toBe("Course Instructor");
    expect(b.peers()[0]?.name).toBe("Ada Lovelace");
    // Never yourself: the local user is drawn by the canvas, not as a peer.
    expect(a.peers().map((peer) => peer.id)).not.toContain(student.id);
  });

  it("relays cursors, including for a client that may not write", async () => {
    const { teacher, student, board } = await seedBoardWithMember("readonly");
    const observer = track(
      createClient(server, board.id, await cookieFor(student.id), {
        id: student.id,
        name: "Ada Lovelace",
      }),
    );
    const watcher = track(
      createClient(server, board.id, await cookieFor(teacher.id), {
        id: teacher.id,
        name: "Course Instructor",
      }),
    );
    await waitForSync(observer);
    await waitForSync(watcher);

    // A read-only student still gets a cursor: presence is not a document write.
    observer.session.setCursor({ x: 120, y: 340 });

    await waitUntil(() => watcher.peers()[0]?.cursor !== null, {
      label: "the cursor to arrive",
    });
    expect(watcher.peers()[0]?.cursor).toEqual({ x: 120, y: 340 });
  });

  it("drops a peer from the list when it disconnects", async () => {
    const { teacher, student, board } = await seedBoardWithMember();
    const leaving = track(
      createClient(server, board.id, await cookieFor(student.id), {
        id: student.id,
        name: "Ada Lovelace",
      }),
    );
    const staying = track(
      createClient(server, board.id, await cookieFor(teacher.id), {
        id: teacher.id,
        name: "Course Instructor",
      }),
    );
    await waitForSync(leaving);
    await waitForSync(staying);
    await waitUntil(() => staying.peers().length === 1, {
      label: "the peer to appear",
    });

    leaving.destroy();
    openClients.splice(openClients.indexOf(leaving), 1);

    await waitUntil(() => staying.peers().length === 0, {
      label: "the peer to disappear",
    });
  });
});
