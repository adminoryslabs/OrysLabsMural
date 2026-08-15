import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "@/lib/auth/users";
import {
  addBoardMember,
  createBoard,
  deleteBoard,
  getBoardAccess,
  listBoardMembers,
  listBoardsForTeacher,
  listBoardsForUser,
  removeBoardMember,
  setBoardStatus,
} from "@/lib/boards/queries";
import { resetDatabase, testDb } from "../setup/db";

async function seedPeople() {
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
  const outsider = await createUser(testDb, {
    email: "outsider@example.com",
    password: "s3cret-password",
    displayName: "Student Two",
  });
  return { teacher, student, outsider };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("createBoard", () => {
  it("creates an active board owned by the teacher", async () => {
    const { teacher } = await seedPeople();
    const board = await createBoard(testDb, {
      title: "Hexagonal Architecture",
      ownerId: teacher.id,
    });

    expect(board.title).toBe("Hexagonal Architecture");
    expect(board.ownerId).toBe(teacher.id);
    expect(board.status).toBe("active");
  });

  it("rejects an empty title", async () => {
    const { teacher } = await seedPeople();
    await expect(
      createBoard(testDb, { title: "   ", ownerId: teacher.id }),
    ).rejects.toThrow();
  });
});

describe("membership", () => {
  it("adds, lists and removes members idempotently", async () => {
    const { teacher, student } = await seedPeople();
    const board = await createBoard(testDb, {
      title: "Class 1",
      ownerId: teacher.id,
    });

    await addBoardMember(testDb, board.id, student.id);
    // Adding twice must not blow up nor duplicate.
    await addBoardMember(testDb, board.id, student.id);

    let members = await listBoardMembers(testDb, board.id);
    expect(members).toHaveLength(1);
    expect(members[0]!.email).toBe("student@example.com");

    await removeBoardMember(testDb, board.id, student.id);
    members = await listBoardMembers(testDb, board.id);
    expect(members).toHaveLength(0);
  });

  it("drops memberships when the board is deleted", async () => {
    const { teacher, student } = await seedPeople();
    const board = await createBoard(testDb, {
      title: "Class 1",
      ownerId: teacher.id,
    });
    await addBoardMember(testDb, board.id, student.id);

    await deleteBoard(testDb, board.id);

    expect(await listBoardsForUser(testDb, student.id)).toHaveLength(0);
  });
});

describe("listBoardsForTeacher", () => {
  it("reports the member count per board", async () => {
    const { teacher, student, outsider } = await seedPeople();
    const a = await createBoard(testDb, { title: "A", ownerId: teacher.id });
    await createBoard(testDb, { title: "B", ownerId: teacher.id });
    await addBoardMember(testDb, a.id, student.id);
    await addBoardMember(testDb, a.id, outsider.id);

    const boards = await listBoardsForTeacher(testDb);
    const byTitle = Object.fromEntries(boards.map((b) => [b.title, b]));

    expect(byTitle["A"]!.memberCount).toBe(2);
    expect(byTitle["B"]!.memberCount).toBe(0);
  });
});

describe("listBoardsForUser", () => {
  it("returns only the boards the student belongs to", async () => {
    const { teacher, student, outsider } = await seedPeople();
    const mine = await createBoard(testDb, {
      title: "Mine",
      ownerId: teacher.id,
    });
    await createBoard(testDb, { title: "Not mine", ownerId: teacher.id });
    await addBoardMember(testDb, mine.id, student.id);

    const boards = await listBoardsForUser(testDb, student.id);
    expect(boards.map((b) => b.title)).toEqual(["Mine"]);
    expect(await listBoardsForUser(testDb, outsider.id)).toHaveLength(0);
  });

  it("includes boards a teacher owns even without an explicit membership", async () => {
    const { teacher } = await seedPeople();
    await createBoard(testDb, { title: "Owned", ownerId: teacher.id });

    const boards = await listBoardsForUser(testDb, teacher.id);
    expect(boards.map((b) => b.title)).toEqual(["Owned"]);
  });
});

describe("setBoardStatus", () => {
  it("persists the status and bumps updated_at", async () => {
    const { teacher } = await seedPeople();
    const board = await createBoard(testDb, {
      title: "Class",
      ownerId: teacher.id,
    });

    const frozen = await setBoardStatus(testDb, board.id, "frozen");
    expect(frozen.status).toBe("frozen");
    expect(frozen.updatedAt.getTime()).toBeGreaterThanOrEqual(
      board.updatedAt.getTime(),
    );

    const readonly = await setBoardStatus(testDb, board.id, "readonly");
    expect(readonly.status).toBe("readonly");
  });

  it("refuses a status the database does not know", async () => {
    const { teacher } = await seedPeople();
    const board = await createBoard(testDb, {
      title: "Class",
      ownerId: teacher.id,
    });

    await expect(
      // Simulates a forged client payload reaching the server action.
      setBoardStatus(testDb, board.id, "open" as never),
    ).rejects.toThrow();
  });
});

describe("getBoardAccess", () => {
  it("is the single authority the websocket server can trust", async () => {
    const { teacher, student, outsider } = await seedPeople();
    const board = await createBoard(testDb, {
      title: "Class",
      ownerId: teacher.id,
    });
    await addBoardMember(testDb, board.id, student.id);

    const memberAccess = await getBoardAccess(testDb, board.id, student.id);
    expect(memberAccess).toMatchObject({
      isMember: true,
      canView: true,
      canWrite: true,
    });
    expect(memberAccess?.board.status).toBe("active");

    const outsiderAccess = await getBoardAccess(testDb, board.id, outsider.id);
    expect(outsiderAccess).toMatchObject({
      isMember: false,
      canView: false,
      canWrite: false,
    });
  });

  it("reflects a freeze immediately for every role", async () => {
    const { teacher, student } = await seedPeople();
    const board = await createBoard(testDb, {
      title: "Class",
      ownerId: teacher.id,
    });
    await addBoardMember(testDb, board.id, student.id);
    await setBoardStatus(testDb, board.id, "frozen");

    const forStudent = await getBoardAccess(testDb, board.id, student.id);
    expect(forStudent).toMatchObject({ canView: true, canWrite: false });

    const forTeacher = await getBoardAccess(testDb, board.id, teacher.id);
    expect(forTeacher).toMatchObject({ canView: true, canWrite: false });
  });

  it("lets teachers write on a readonly board while students only read", async () => {
    const { teacher, student } = await seedPeople();
    const board = await createBoard(testDb, {
      title: "Class",
      ownerId: teacher.id,
    });
    await addBoardMember(testDb, board.id, student.id);
    await setBoardStatus(testDb, board.id, "readonly");

    expect(await getBoardAccess(testDb, board.id, student.id)).toMatchObject({
      canView: true,
      canWrite: false,
    });
    expect(await getBoardAccess(testDb, board.id, teacher.id)).toMatchObject({
      canView: true,
      canWrite: true,
    });
  });

  it("returns null for a board that does not exist", async () => {
    const { student } = await seedPeople();
    const access = await getBoardAccess(
      testDb,
      "00000000-0000-0000-0000-00000000dead",
      student.id,
    );
    expect(access).toBeNull();
  });
});
