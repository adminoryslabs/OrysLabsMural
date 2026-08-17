import { beforeEach, describe, expect, it } from "vitest";
import {
  canViewBoard,
  canWriteToBoard,
} from "@/lib/boards/authority";
import {
  addBoardMember,
  createBoard,
  getBoardAccess,
  listBoardRoster,
  listBoardsForUser,
  removeBoardMembers,
  setBoardClassroom,
  setBoardStatus,
} from "@/lib/boards/queries";
import {
  addClassroomMembers,
  createClassroom,
  deleteClassroom,
  removeClassroomMembers,
} from "@/lib/classrooms/queries";
import type { BoardStatus } from "@/lib/db/schema";
import { resetDatabase, testDb } from "../setup/db";
import { seedBoardWithMember, seedCohort } from "../setup/fixtures";

/**
 * THE SECURITY BOUNDARY.
 *
 * A user reaches a board if they are a teacher, OR they belong to the board's
 * classroom, OR they are listed in `board_members`. Everything below is against
 * a real PostgreSQL instance, through the same `getBoardAccess` the websocket
 * server re-reads on every write frame — never a mock, and never the pure rules
 * on their own, because a rule that is right about inputs the query never
 * produces protects nobody.
 */

beforeEach(async () => {
  await resetDatabase();
});

describe("the classroom is the source of truth", () => {
  it("lets a student of the classroom view and write every board of it", async () => {
    const { cohortStudent, board, secondBoard } = await seedCohort();

    for (const target of [board, secondBoard]) {
      expect(await getBoardAccess(testDb, target.id, cohortStudent.id))
        .toMatchObject({
          isMember: false,
          isClassroomMember: true,
          canView: true,
          canWrite: true,
        });
    }
  });

  it("adding a student to the classroom grants EVERY board of it at once", async () => {
    const { outsider, classroom, board, secondBoard } = await seedCohort();

    // Before: nothing, on either board.
    expect(await getBoardAccess(testDb, board.id, outsider.id)).toMatchObject({
      canView: false,
    });
    expect(
      await getBoardAccess(testDb, secondBoard.id, outsider.id),
    ).toMatchObject({ canView: false });

    await addClassroomMembers(testDb, classroom.id, [outsider.id]);

    // After: both, with no per-board action in between. Nothing was copied.
    for (const target of [board, secondBoard]) {
      expect(await getBoardAccess(testDb, target.id, outsider.id)).toMatchObject(
        { isClassroomMember: true, canView: true, canWrite: true },
      );
    }
  });

  it("removing a student from the classroom revokes EVERY board of it at once", async () => {
    const { cohortStudent, classroom, board, secondBoard } = await seedCohort();

    await removeClassroomMembers(testDb, classroom.id, [cohortStudent.id]);

    for (const target of [board, secondBoard]) {
      expect(
        await getBoardAccess(testDb, target.id, cohortStudent.id),
      ).toMatchObject({
        isMember: false,
        isClassroomMember: false,
        canView: false,
        canWrite: false,
      });
    }
  });

  it("clearing a board's classroom revokes the cohort on that board alone", async () => {
    const { cohortStudent, board, secondBoard } = await seedCohort();

    await setBoardClassroom(testDb, board.id, null);

    expect(
      await getBoardAccess(testDb, board.id, cohortStudent.id),
    ).toMatchObject({ canView: false, canWrite: false });
    // The other board of the same classroom is untouched.
    expect(
      await getBoardAccess(testDb, secondBoard.id, cohortStudent.id),
    ).toMatchObject({ canView: true, canWrite: true });
  });

  it("deleting the classroom detaches its boards instead of destroying them", async () => {
    const { cohortStudent, guest, classroom, board, secondBoard } =
      await seedCohort();

    await deleteClassroom(testDb, classroom.id);

    // The boards survive, with no classroom.
    const detached = await getBoardAccess(testDb, board.id, guest.id);
    expect(detached?.board.classroomId).toBeNull();
    expect(await getBoardAccess(testDb, secondBoard.id, guest.id)).not.toBeNull();

    // The cohort loses them; the explicit exception keeps its board.
    expect(
      await getBoardAccess(testDb, board.id, cohortStudent.id),
    ).toMatchObject({ canView: false });
    expect(detached).toMatchObject({ isMember: true, canView: true });
  });
});

describe("the explicit board_members escape hatch is ADDITIVE", () => {
  it("gives access to someone who is NOT in the classroom", async () => {
    const { guest, board } = await seedCohort();

    expect(await getBoardAccess(testDb, board.id, guest.id)).toMatchObject({
      isMember: true,
      isClassroomMember: false,
      canView: true,
      canWrite: true,
    });
  });

  it("does not leak onto the other boards of the classroom", async () => {
    const { guest, secondBoard } = await seedCohort();

    expect(
      await getBoardAccess(testDb, secondBoard.id, guest.id),
    ).toMatchObject({ canView: false, canWrite: false });
  });

  it("never removes what the classroom already granted", async () => {
    const { cohortStudent, board } = await seedCohort();
    // Listed explicitly as well as being in the cohort, then removed from the
    // explicit list: the classroom grant must survive untouched.
    await addBoardMember(testDb, board.id, cohortStudent.id);
    expect(await getBoardAccess(testDb, board.id, cohortStudent.id))
      .toMatchObject({ isMember: true, isClassroomMember: true });

    await removeBoardMembers(testDb, board.id, [cohortStudent.id]);

    expect(
      await getBoardAccess(testDb, board.id, cohortStudent.id),
    ).toMatchObject({
      isMember: false,
      isClassroomMember: true,
      canView: true,
      canWrite: true,
    });
  });
});

describe("a non-member is indistinguishable from a missing board", () => {
  it("returns the same shape of refusal for both", async () => {
    const { outsider, board } = await seedCohort();

    const refused = await getBoardAccess(testDb, board.id, outsider.id);
    const missing = await getBoardAccess(
      testDb,
      "00000000-0000-4000-8000-000000000000",
      outsider.id,
    );

    // The web app renders notFound() for `null` AND for `canView === false`,
    // and the websocket server closes both with 4404. Neither answer tells the
    // outsider whether the board exists.
    expect(missing).toBeNull();
    expect(refused?.canView).toBe(false);
  });

  it("keeps refusing after the board is assigned to a classroom they are not in", async () => {
    const { teacher, outsider, classroom, secondBoard } = await seedCohort();
    const other = await createClassroom(testDb, {
      name: "Some other cohort",
      ownerId: teacher.id,
    });
    await addClassroomMembers(testDb, other.id, [outsider.id]);

    // Being in SOME classroom is not being in THIS one.
    expect(secondBoard.classroomId).toBe(classroom.id);
    expect(
      await getBoardAccess(testDb, secondBoard.id, outsider.id),
    ).toMatchObject({ isClassroomMember: false, canView: false });
  });
});

describe("status outranks both membership paths", () => {
  const cases: BoardStatus[] = ["frozen", "readonly"];

  it.each(cases)("%s beats classroom membership", async (status) => {
    const { cohortStudent, board } = await seedCohort();
    await setBoardStatus(testDb, board.id, status);

    const access = await getBoardAccess(testDb, board.id, cohortStudent.id);
    expect(access).toMatchObject({
      isClassroomMember: true,
      canView: true,
      canWrite: false,
    });
  });

  it.each(cases)("%s beats the explicit exception", async (status) => {
    const { guest, board } = await seedCohort();
    await setBoardStatus(testDb, board.id, status);

    expect(await getBoardAccess(testDb, board.id, guest.id)).toMatchObject({
      isMember: true,
      canView: true,
      canWrite: false,
    });
  });

  it("frozen stops the owning teacher too, classroom or not", async () => {
    const { teacher, board } = await seedCohort();
    await setBoardStatus(testDb, board.id, "frozen");

    expect(await getBoardAccess(testDb, board.id, teacher.id)).toMatchObject({
      canView: true,
      canWrite: false,
    });
  });
});

describe("teachers are unaffected by classrooms", () => {
  it("view and write every board without belonging to anything", async () => {
    const { teacher, board, secondBoard } = await seedCohort();

    for (const target of [board, secondBoard]) {
      expect(await getBoardAccess(testDb, target.id, teacher.id)).toMatchObject({
        isMember: false,
        isClassroomMember: false,
        canView: true,
        canWrite: true,
      });
    }
  });

  it("reach a board of a classroom another teacher created", async () => {
    const { board } = await seedCohort();
    const { teacher: otherTeacher } = await seedBoardWithMember();

    expect(await getBoardAccess(testDb, board.id, otherTeacher.id))
      .toMatchObject({ canView: true, canWrite: true });
  });
});

describe("a board with classroom_id = null behaves exactly as before", () => {
  it("grants only its explicit members", async () => {
    const { student, outsider, board } = await seedBoardWithMember();

    expect(board.classroomId).toBeNull();
    expect(await getBoardAccess(testDb, board.id, student.id)).toMatchObject({
      isMember: true,
      isClassroomMember: false,
      canView: true,
      canWrite: true,
    });
    expect(await getBoardAccess(testDb, board.id, outsider.id)).toMatchObject({
      isMember: false,
      isClassroomMember: false,
      canView: false,
      canWrite: false,
    });
  });

  it("is not opened by membership of an unrelated classroom", async () => {
    const { teacher, outsider, board } = await seedBoardWithMember();
    const classroom = await createClassroom(testDb, {
      name: "A cohort this board is not taught to",
      ownerId: teacher.id,
    });
    await addClassroomMembers(testDb, classroom.id, [outsider.id]);

    // The join is on `boards.classroom_id`, which is null here: a null
    // classroom must never match a real classroom row.
    expect(await getBoardAccess(testDb, board.id, outsider.id)).toMatchObject({
      isClassroomMember: false,
      canView: false,
    });
  });
});

describe("the pure rules refuse to be talked into a grant", () => {
  const board = {
    id: "b",
    ownerId: "00000000-0000-0000-0000-0000000000a1",
    status: "active" as BoardStatus,
  };
  const student = { id: "s", role: "student" as const };

  it("grants nothing when neither membership flag is set", () => {
    expect(canViewBoard({ board, user: student, isMember: false })).toBe(false);
    expect(canWriteToBoard({ board, user: student, isMember: false })).toBe(
      false,
    );
  });

  it("treats an absent classroom flag as no access, not as access", () => {
    // Fail closed: a caller that never looked the classroom up grants nothing.
    expect(
      canViewBoard({
        board,
        user: student,
        isMember: false,
        isClassroomMember: undefined,
      }),
    ).toBe(false);
  });

  it("is a union, so either flag alone is enough", () => {
    expect(
      canWriteToBoard({
        board,
        user: student,
        isMember: false,
        isClassroomMember: true,
      }),
    ).toBe(true);
    expect(
      canWriteToBoard({
        board,
        user: student,
        isMember: true,
        isClassroomMember: false,
      }),
    ).toBe(true);
  });
});

describe("the listings agree with the authority", () => {
  it("shows a cohort student every board of their classroom", async () => {
    const { cohortStudent, board, secondBoard } = await seedCohort();

    const titles = (await listBoardsForUser(testDb, cohortStudent.id))
      .map((row) => row.title)
      .sort();
    expect(titles).toEqual([board.title, secondBoard.title].sort());
  });

  it("shows the guest only the board they were listed on", async () => {
    const { guest, board } = await seedCohort();

    expect(
      (await listBoardsForUser(testDb, guest.id)).map((row) => row.title),
    ).toEqual([board.title]);
  });

  it("shows the outsider nothing", async () => {
    const { outsider } = await seedCohort();
    expect(await listBoardsForUser(testDb, outsider.id)).toHaveLength(0);
  });

  it("lists a board's roster once per person, flagging the exception", async () => {
    const { cohortStudent, guest, board } = await seedCohort();
    // Also listed explicitly: they must appear once, not twice.
    await addBoardMember(testDb, board.id, cohortStudent.id);

    const roster = await listBoardRoster(testDb, board.id);
    expect(roster.map((row) => row.id).sort()).toEqual(
      [cohortStudent.id, guest.id].sort(),
    );
    expect(roster.every((row) => row.isExplicitMember)).toBe(true);
  });

  it("gives an unassigned board the roster it always had", async () => {
    const { teacher, student } = await seedBoardWithMember();
    const board = await createBoard(testDb, {
      title: "No classroom",
      ownerId: teacher.id,
    });
    await addBoardMember(testDb, board.id, student.id);

    const roster = await listBoardRoster(testDb, board.id);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({
      id: student.id,
      isExplicitMember: true,
    });
  });
});
