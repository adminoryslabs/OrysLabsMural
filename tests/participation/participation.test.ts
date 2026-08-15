import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "@/lib/auth/users";
import { addBoardMember, createBoard } from "@/lib/boards/queries";
import {
  closeStaleBoardSessions,
  endBoardSession,
  getBoardParticipation,
  getUserParticipation,
  recordBoardActivity,
  startBoardSession,
} from "@/lib/participation/queries";
import { resetDatabase, testDb } from "../setup/db";

const MINUTE = 60_000;

async function seed() {
  const teacher = await createUser(testDb, {
    email: "teacher@example.com",
    password: "s3cret-password",
    displayName: "Teacher",
    role: "teacher",
  });
  const student = await createUser(testDb, {
    email: "student@example.com",
    password: "s3cret-password",
    displayName: "Student One",
  });
  const boardA = await createBoard(testDb, {
    title: "Board A",
    ownerId: teacher.id,
  });
  const boardB = await createBoard(testDb, {
    title: "Board B",
    ownerId: teacher.id,
  });
  await addBoardMember(testDb, boardA.id, student.id);
  await addBoardMember(testDb, boardB.id, student.id);
  return { teacher, student, boardA, boardB };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("startBoardSession", () => {
  it("opens a row that is still open", async () => {
    const { student, boardA } = await seed();
    const session = await startBoardSession(testDb, {
      boardId: boardA.id,
      userId: student.id,
      connectionId: "conn-1",
    });

    expect(session.disconnectedAt).toBeNull();
    expect(session.editCount).toBe(0);
    expect(session.connectionId).toBe("conn-1");
  });

  it("keeps two tabs of the same user as two independent sessions", async () => {
    const { student, boardA } = await seed();
    const a = await startBoardSession(testDb, {
      boardId: boardA.id,
      userId: student.id,
      connectionId: "conn-1",
    });
    const b = await startBoardSession(testDb, {
      boardId: boardA.id,
      userId: student.id,
      connectionId: "conn-2",
    });
    expect(a.id).not.toBe(b.id);
  });
});

describe("recordBoardActivity", () => {
  it("accumulates edits and moves the heartbeat forward", async () => {
    const { student, boardA } = await seed();
    const start = new Date("2026-01-01T10:00:00.000Z");
    const session = await startBoardSession(testDb, {
      boardId: boardA.id,
      userId: student.id,
      now: start,
    });

    await recordBoardActivity(testDb, session.id, {
      edits: 3,
      now: new Date(start.getTime() + MINUTE),
    });
    const updated = await recordBoardActivity(testDb, session.id, {
      edits: 2,
      now: new Date(start.getTime() + 2 * MINUTE),
    });

    expect(updated!.editCount).toBe(5);
    expect(updated!.lastSeenAt.getTime()).toBe(start.getTime() + 2 * MINUTE);
  });

  it("ignores a heartbeat for an unknown session instead of throwing", async () => {
    const result = await recordBoardActivity(
      testDb,
      "00000000-0000-0000-0000-00000000dead",
      { edits: 1 },
    );
    expect(result).toBeNull();
  });
});

describe("endBoardSession", () => {
  it("closes the row and freezes the participation window", async () => {
    const { student, boardA } = await seed();
    const start = new Date("2026-01-01T10:00:00.000Z");
    const end = new Date(start.getTime() + 10 * MINUTE);
    const session = await startBoardSession(testDb, {
      boardId: boardA.id,
      userId: student.id,
      now: start,
    });

    const closed = await endBoardSession(testDb, session.id, { now: end });
    expect(closed!.disconnectedAt!.getTime()).toBe(end.getTime());

    // Closing twice must not move the original disconnect time.
    const again = await endBoardSession(testDb, session.id, {
      now: new Date(end.getTime() + MINUTE),
    });
    expect(again!.disconnectedAt!.getTime()).toBe(end.getTime());
  });
});

describe("getUserParticipation", () => {
  it("answers 'which boards did this student join, and how much'", async () => {
    const { student, boardA, boardB } = await seed();
    const t0 = new Date("2026-01-01T10:00:00.000Z");

    const s1 = await startBoardSession(testDb, {
      boardId: boardA.id,
      userId: student.id,
      now: t0,
    });
    await recordBoardActivity(testDb, s1.id, {
      edits: 4,
      now: new Date(t0.getTime() + 10 * MINUTE),
    });
    await endBoardSession(testDb, s1.id, {
      now: new Date(t0.getTime() + 10 * MINUTE),
    });

    const s2 = await startBoardSession(testDb, {
      boardId: boardA.id,
      userId: student.id,
      now: new Date(t0.getTime() + 60 * MINUTE),
    });
    await recordBoardActivity(testDb, s2.id, {
      edits: 1,
      now: new Date(t0.getTime() + 65 * MINUTE),
    });
    await endBoardSession(testDb, s2.id, {
      now: new Date(t0.getTime() + 65 * MINUTE),
    });

    const s3 = await startBoardSession(testDb, {
      boardId: boardB.id,
      userId: student.id,
      now: t0,
    });
    await endBoardSession(testDb, s3.id, {
      now: new Date(t0.getTime() + 2 * MINUTE),
    });

    const rows = await getUserParticipation(testDb, student.id);
    const byBoard = Object.fromEntries(rows.map((r) => [r.boardTitle, r]));

    expect(byBoard["Board A"]).toMatchObject({
      sessionCount: 2,
      totalSeconds: 15 * 60,
      totalEdits: 5,
    });
    expect(byBoard["Board A"]!.firstSeenAt.getTime()).toBe(t0.getTime());
    expect(byBoard["Board A"]!.lastSeenAt.getTime()).toBe(
      t0.getTime() + 65 * MINUTE,
    );

    expect(byBoard["Board B"]).toMatchObject({
      sessionCount: 1,
      totalSeconds: 2 * 60,
      totalEdits: 0,
    });
  });

  it("bounds an open session by its last heartbeat, not by wall clock", async () => {
    const { student, boardA } = await seed();
    const t0 = new Date("2026-01-01T10:00:00.000Z");
    const session = await startBoardSession(testDb, {
      boardId: boardA.id,
      userId: student.id,
      now: t0,
    });
    await recordBoardActivity(testDb, session.id, {
      edits: 0,
      now: new Date(t0.getTime() + 5 * MINUTE),
    });

    const rows = await getUserParticipation(testDb, student.id);
    // A tab abandoned in 2026 must not accrue time forever.
    expect(rows[0]!.totalSeconds).toBe(5 * 60);
  });

  it("returns nothing for a student who never connected", async () => {
    const { teacher } = await seed();
    expect(await getUserParticipation(testDb, teacher.id)).toHaveLength(0);
  });
});

describe("getBoardParticipation", () => {
  it("lists who took part in a board and how much", async () => {
    const { teacher, student, boardA } = await seed();
    const t0 = new Date("2026-01-01T10:00:00.000Z");

    const s1 = await startBoardSession(testDb, {
      boardId: boardA.id,
      userId: student.id,
      now: t0,
    });
    await endBoardSession(testDb, s1.id, {
      now: new Date(t0.getTime() + 3 * MINUTE),
    });
    const s2 = await startBoardSession(testDb, {
      boardId: boardA.id,
      userId: teacher.id,
      now: t0,
    });
    await endBoardSession(testDb, s2.id, {
      now: new Date(t0.getTime() + MINUTE),
    });

    const rows = await getBoardParticipation(testDb, boardA.id);
    const byName = Object.fromEntries(rows.map((r) => [r.displayName, r]));

    expect(byName["Student One"]).toMatchObject({ totalSeconds: 180 });
    expect(byName["Teacher"]).toMatchObject({ totalSeconds: 60 });
  });
});

describe("closeStaleBoardSessions", () => {
  it("closes sessions whose heartbeat went silent, at their last heartbeat", async () => {
    const { student, boardA } = await seed();
    const t0 = new Date("2026-01-01T10:00:00.000Z");
    const stale = await startBoardSession(testDb, {
      boardId: boardA.id,
      userId: student.id,
      now: t0,
    });
    const alive = await startBoardSession(testDb, {
      boardId: boardA.id,
      userId: student.id,
      now: new Date(t0.getTime() + 59 * MINUTE),
    });

    const closed = await closeStaleBoardSessions(testDb, {
      staleAfterSeconds: 120,
      now: new Date(t0.getTime() + 60 * MINUTE),
    });

    expect(closed).toBe(1);
    const rows = await getBoardParticipation(testDb, boardA.id);
    expect(rows[0]!.openSessionCount).toBe(1);
    expect(stale.id).not.toBe(alive.id);
  });
});
