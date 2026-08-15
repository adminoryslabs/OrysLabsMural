import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeBoardMember, setBoardStatus } from "@/lib/boards/queries";
import type { YjsServer } from "@/yjs-server/server";
import { resetDatabase, testDb } from "../setup/db";
import { seedClassroom } from "../setup/fixtures";
import {
  cookieFor,
  createClient,
  expectNeverArrives,
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

describe("write authority on an active board", () => {
  it("relays an update from a member to every other client", async () => {
    const { teacher, student, board } = await seedClassroom("active");
    const writer = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    const reader = track(
      createClient(server, board.id, await cookieFor(teacher.id)),
    );
    await waitForSync(writer);
    await waitForSync(reader);

    writer.shapes.set("rect-1", { id: "rect-1", type: "rectangle" });

    await waitUntil(() => reader.shapes.has("rect-1"), {
      label: "the peer to receive the update",
    });
    expect(reader.shapes.get("rect-1")).toEqual({
      id: "rect-1",
      type: "rectangle",
    });
  });
});

describe("write authority on a readonly board", () => {
  it("rejects a student update and never relays it", async () => {
    const { teacher, student, board } = await seedClassroom("readonly");
    const studentClient = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    const teacherClient = track(
      createClient(server, board.id, await cookieFor(teacher.id)),
    );
    await waitForSync(studentClient);
    await waitForSync(teacherClient);

    studentClient.shapes.set("forbidden", { id: "forbidden" });

    await expectNeverArrives(() => teacherClient.shapes.has("forbidden"));
  });

  it("still accepts the teacher's update", async () => {
    const { teacher, student, board } = await seedClassroom("readonly");
    const teacherClient = track(
      createClient(server, board.id, await cookieFor(teacher.id)),
    );
    const studentClient = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(teacherClient);
    await waitForSync(studentClient);

    teacherClient.shapes.set("lecture-note", { id: "lecture-note" });

    await waitUntil(() => studentClient.shapes.has("lecture-note"), {
      label: "the student to receive the teacher's update",
    });
  });
});

describe("write authority on a frozen board", () => {
  it("rejects everyone, the owning teacher included", async () => {
    const { teacher, student, board } = await seedClassroom("frozen");
    const teacherClient = track(
      createClient(server, board.id, await cookieFor(teacher.id)),
    );
    const studentClient = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(teacherClient);
    await waitForSync(studentClient);

    teacherClient.shapes.set("owner-write", { id: "owner-write" });
    studentClient.shapes.set("student-write", { id: "student-write" });

    await expectNeverArrives(
      () =>
        studentClient.shapes.has("owner-write") ||
        teacherClient.shapes.has("student-write"),
    );
  });

  it("still lets both of them read the existing document", async () => {
    const { teacher, student, board } = await seedClassroom("active");
    const author = track(
      createClient(server, board.id, await cookieFor(teacher.id)),
    );
    await waitForSync(author);
    author.shapes.set("before-freeze", { id: "before-freeze" });
    await waitUntil(() => server.roomCount() === 1, { label: "the room" });
    await new Promise((resolve) => setTimeout(resolve, 150));

    await setBoardStatus(testDb, board.id, "frozen");

    const late = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    await waitForSync(late);
    await waitUntil(() => late.shapes.has("before-freeze"), {
      label: "the frozen document to be readable",
    });
  });
});

describe("freezing mid-session", () => {
  it("stops accepting updates from a client that was already connected", async () => {
    const { teacher, student, board } = await seedClassroom("active");
    const writer = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    const reader = track(
      createClient(server, board.id, await cookieFor(teacher.id)),
    );
    await waitForSync(writer);
    await waitForSync(reader);

    // Before the freeze the write goes through: this proves the connection is
    // healthy, so the later rejection cannot be a false negative.
    writer.shapes.set("allowed", { id: "allowed" });
    await waitUntil(() => reader.shapes.has("allowed"), {
      label: "the pre-freeze update",
    });

    // The teacher freezes the board from the Next.js panel; the websocket
    // server holds no cached verdict, so the next write must be refused.
    await setBoardStatus(testDb, board.id, "frozen");

    writer.shapes.set("after-freeze", { id: "after-freeze" });
    await expectNeverArrives(() => reader.shapes.has("after-freeze"));
  });

  it("resynchronises the refused client and lets it write again once unfrozen", async () => {
    const { teacher, student, board } = await seedClassroom("frozen");
    const writer = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    const reader = track(
      createClient(server, board.id, await cookieFor(teacher.id)),
    );
    await waitForSync(writer);
    await waitForSync(reader);

    writer.shapes.set("while-frozen", { id: "while-frozen" });
    await expectNeverArrives(() => reader.shapes.has("while-frozen"));

    // The refusal is reported to the client, which throws its diverged
    // document away and takes the server's copy again. Without that, every
    // later update from this client would reference operations the server
    // never accepted, and the CRDT would silently stop converging.
    await waitUntil(() => writer.denials > 0, {
      label: "the client to be told its write was refused",
    });
    await waitUntil(() => !writer.shapes.has("while-frozen"), {
      label: "the refused change to be rolled back locally",
    });

    await setBoardStatus(testDb, board.id, "active");
    await waitForSync(writer);

    writer.shapes.set("after-thaw", { id: "after-thaw" });
    await waitUntil(() => reader.shapes.has("after-thaw"), {
      label: "writes to resume after unfreezing",
    });
  });

  it("refuses writes from a member who was removed from the board mid-session", async () => {
    const { teacher, student, board } = await seedClassroom("active");
    const writer = track(
      createClient(server, board.id, await cookieFor(student.id)),
    );
    const reader = track(
      createClient(server, board.id, await cookieFor(teacher.id)),
    );
    await waitForSync(writer);
    await waitForSync(reader);

    writer.shapes.set("allowed", { id: "allowed" });
    await waitUntil(() => reader.shapes.has("allowed"), {
      label: "the pre-removal update",
    });

    await removeBoardMember(testDb, board.id, student.id);

    writer.shapes.set("after-removal", { id: "after-removal" });
    await expectNeverArrives(() => reader.shapes.has("after-removal"));
  });
});
