import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBoardStatus } from "@/lib/boards/queries";
import { removeClassroomMembers } from "@/lib/classrooms/queries";
import {
  CLOSE_NOT_FOUND,
} from "@/yjs-server/close-codes";
import type { YjsServer } from "@/yjs-server/server";
import { resetDatabase, testDb } from "../setup/db";
import { seedCohort } from "../setup/fixtures";
import {
  cookieFor,
  createClient,
  expectNeverArrives,
  rawConnect,
  startTestServer,
  waitForSync,
  waitUntil,
} from "../setup/yjs";

/**
 * The classroom grant, proved through the REAL websocket server over a real
 * socket. The rules being right is not the same claim as the server enforcing
 * them: this suite speaks the shipped protocol to the shipped process.
 */

let server: YjsServer;

beforeEach(async () => {
  await resetDatabase();
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

describe("handshake through a classroom", () => {
  it("accepts a student whose only claim is the classroom", async () => {
    const { cohortStudent, board } = await seedCohort();

    const { socket, firstMessage } = rawConnect(
      server,
      `/${board.id}`,
      await cookieFor(cohortStudent.id),
    );

    expect((await firstMessage)[0]).toBe(0); // messageSync
    socket.close();
  });

  it("accepts the guest listed only in board_members", async () => {
    const { guest, board } = await seedCohort();

    const { socket, firstMessage } = rawConnect(
      server,
      `/${board.id}`,
      await cookieFor(guest.id),
    );

    expect((await firstMessage)[0]).toBe(0);
    socket.close();
  });

  it("closes the guest on the OTHER board of the classroom, exactly like a missing board", async () => {
    const { guest, secondBoard } = await seedCohort();
    const cookie = await cookieFor(guest.id);

    const refused = rawConnect(server, `/${secondBoard.id}`, cookie);
    const missing = rawConnect(
      server,
      "/00000000-0000-4000-8000-000000000000",
      cookie,
    );

    const refusedClose = await refused.closed;
    const missingClose = await missing.closed;

    expect(refusedClose.code).toBe(CLOSE_NOT_FOUND);
    expect(missingClose.code).toBe(CLOSE_NOT_FOUND);
    // Byte for byte the same answer: membership cannot be probed from outside.
    expect(refusedClose.reason).toBe(missingClose.reason);
  });

  it("closes an outsider with the same answer as a missing board", async () => {
    const { outsider, board } = await seedCohort();
    const cookie = await cookieFor(outsider.id);

    const refused = rawConnect(server, `/${board.id}`, cookie);
    const missing = rawConnect(
      server,
      "/00000000-0000-4000-8000-000000000000",
      cookie,
    );

    const refusedClose = await refused.closed;
    const missingClose = await missing.closed;
    expect(refusedClose.code).toBe(CLOSE_NOT_FOUND);
    expect(refusedClose.reason).toBe(missingClose.reason);
  });
});

describe("writes through a classroom", () => {
  it("relays a write from a classroom student to a peer", async () => {
    const { teacher, cohortStudent, board } = await seedCohort();
    const writer = createClient(
      server,
      board.id,
      await cookieFor(cohortStudent.id),
      { id: cohortStudent.id, name: cohortStudent.displayName },
    );
    const watcher = createClient(server, board.id, await cookieFor(teacher.id), {
      id: teacher.id,
      name: teacher.displayName,
    });
    await waitForSync(writer);
    await waitForSync(watcher);

    writer.shapes.set("note", "written through the classroom");

    await waitUntil(() => watcher.shapes.get("note") !== undefined, {
      label: "the peer to receive the update",
    });
    expect(watcher.shapes.get("note")).toBe("written through the classroom");

    writer.destroy();
    watcher.destroy();
  });

  it("drops a write once the student leaves the classroom, with no reconnect", async () => {
    const { teacher, cohortStudent, classroom, board } = await seedCohort();
    const writer = createClient(
      server,
      board.id,
      await cookieFor(cohortStudent.id),
      { id: cohortStudent.id, name: cohortStudent.displayName },
    );
    const watcher = createClient(server, board.id, await cookieFor(teacher.id), {
      id: teacher.id,
      name: teacher.displayName,
    });
    await waitForSync(writer);
    await waitForSync(watcher);

    // Revoked in the database only. Nothing tells the client.
    await removeClassroomMembers(testDb, classroom.id, [
      cohortStudent.id,
    ]);

    writer.shapes.set("after-removal", "should never arrive");

    // The write path re-reads getBoardAccess for EVERY update, so there is no
    // cached verdict to outlive the revocation.
    await expectNeverArrives(
      () => watcher.shapes.get("after-removal") !== undefined,
    );

    writer.destroy();
    watcher.destroy();
  });

  it("refuses a frozen board to a classroom student", async () => {
    const { teacher, cohortStudent, board } = await seedCohort();
    const writer = createClient(
      server,
      board.id,
      await cookieFor(cohortStudent.id),
      { id: cohortStudent.id, name: cohortStudent.displayName },
    );
    const watcher = createClient(server, board.id, await cookieFor(teacher.id), {
      id: teacher.id,
      name: teacher.displayName,
    });
    await waitForSync(writer);
    await waitForSync(watcher);

    await setBoardStatus(testDb, board.id, "frozen");
    // Let the status poll push the new authority to the connected client.
    await waitUntil(() => writer.authority?.status === "frozen", {
      label: "the freeze to reach the client",
    });
    expect(writer.authority?.canWrite).toBe(false);

    writer.shapes.set("while-frozen", "should never arrive");
    await expectNeverArrives(
      () => watcher.shapes.get("while-frozen") !== undefined,
    );

    writer.destroy();
    watcher.destroy();
  });
});
