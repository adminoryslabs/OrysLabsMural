import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "@/lib/auth/users";
import { createBoard, deleteBoard } from "@/lib/boards/queries";
import {
  getLatestBoardSnapshot,
  pruneBoardSnapshots,
  saveBoardSnapshot,
} from "@/lib/boards/snapshots";
import { resetDatabase, testDb } from "../setup/db";

async function seedBoard() {
  const teacher = await createUser(testDb, {
    email: "teacher@example.com",
    password: "s3cret-password",
    displayName: "Teacher",
    role: "teacher",
  });
  return createBoard(testDb, { title: "Class", ownerId: teacher.id });
}

beforeEach(async () => {
  await resetDatabase();
});

describe("board snapshots", () => {
  it("round-trips the binary Yjs state unchanged", async () => {
    const board = await seedBoard();
    const state = new Uint8Array([0, 1, 2, 255, 128, 0, 7]);

    await saveBoardSnapshot(testDb, board.id, state);
    const latest = await getLatestBoardSnapshot(testDb, board.id);

    expect(latest).not.toBeNull();
    expect(Array.from(latest!.state)).toEqual(Array.from(state));
  });

  it("returns the newest snapshot", async () => {
    const board = await seedBoard();
    await saveBoardSnapshot(testDb, board.id, new Uint8Array([1]), {
      now: new Date("2026-01-01T10:00:00.000Z"),
    });
    await saveBoardSnapshot(testDb, board.id, new Uint8Array([2, 2]), {
      now: new Date("2026-01-01T11:00:00.000Z"),
    });

    const latest = await getLatestBoardSnapshot(testDb, board.id);
    expect(Array.from(latest!.state)).toEqual([2, 2]);
  });

  it("returns null when a board has no snapshot yet", async () => {
    const board = await seedBoard();
    expect(await getLatestBoardSnapshot(testDb, board.id)).toBeNull();
  });

  it("keeps only the newest N snapshots when pruned", async () => {
    const board = await seedBoard();
    for (let i = 1; i <= 5; i++) {
      await saveBoardSnapshot(testDb, board.id, new Uint8Array([i]), {
        now: new Date(Date.UTC(2026, 0, 1, 10, i)),
      });
    }

    const removed = await pruneBoardSnapshots(testDb, board.id, 2);
    expect(removed).toBe(3);

    const latest = await getLatestBoardSnapshot(testDb, board.id);
    expect(Array.from(latest!.state)).toEqual([5]);
  });

  it("is removed together with its board", async () => {
    const board = await seedBoard();
    await saveBoardSnapshot(testDb, board.id, new Uint8Array([1]));

    await deleteBoard(testDb, board.id);

    expect(await getLatestBoardSnapshot(testDb, board.id)).toBeNull();
  });
});
