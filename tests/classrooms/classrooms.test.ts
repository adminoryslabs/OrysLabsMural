import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "@/lib/auth/users";
import { getBoardAccess } from "@/lib/boards/queries";
import {
  canAdministerClassroom,
  canDeleteClassroom,
} from "@/lib/classrooms/authority";
import {
  addClassroomMembersBatch,
  removeClassroomMembersBatch,
} from "@/lib/classrooms/membership";
import {
  DuplicateClassroomNameError,
  createClassroom,
  deleteClassroom,
  getClassroomById,
  listClassroomMembers,
  listClassrooms,
  renameClassroom,
} from "@/lib/classrooms/queries";
import { MembershipAuthorizationError } from "@/lib/members/batch";
import { resetDatabase, testDb } from "../setup/db";
import { seedCohort } from "../setup/fixtures";

beforeEach(async () => {
  await resetDatabase();
});

describe("classroom lifecycle", () => {
  it("creates, renames and lists a classroom with its counts", async () => {
    const { teacher, classroom } = await seedCohort();

    const [listed] = await listClassrooms(testDb);
    expect(listed).toMatchObject({
      id: classroom.id,
      ownerName: teacher.displayName,
      memberCount: 1,
      boardCount: 2,
    });

    const renamed = await renameClassroom(testDb, classroom.id, "  Cohort B  ");
    expect(renamed.name).toBe("Cohort B");
  });

  it("refuses an empty name", async () => {
    const { teacher } = await seedCohort();
    await expect(
      createClassroom(testDb, { name: "   ", ownerId: teacher.id }),
    ).rejects.toThrow();
  });

  it("refuses a duplicate name rather than creating a second identical picker entry", async () => {
    const { teacher, classroom } = await seedCohort();
    await expect(
      createClassroom(testDb, { name: classroom.name, ownerId: teacher.id }),
    ).rejects.toBeInstanceOf(DuplicateClassroomNameError);
  });

  it("deletes the classroom and its membership, but not its boards", async () => {
    const { classroom, board, cohortStudent } = await seedCohort();

    await deleteClassroom(testDb, classroom.id);

    expect(await getClassroomById(testDb, classroom.id)).toBeNull();
    expect(await listClassroomMembers(testDb, classroom.id)).toHaveLength(0);
    // The board is still there, detached, and the cohort no longer reaches it.
    const access = await getBoardAccess(testDb, board.id, cohortStudent.id);
    expect(access).not.toBeNull();
    expect(access?.board.classroomId).toBeNull();
    expect(access?.canView).toBe(false);
  });
});

describe("classroom authority", () => {
  it("lets any teacher administer, and only the creator delete", () => {
    const classroom = { ownerId: "owner" };
    const owner = { id: "owner", role: "teacher" as const };
    const other = { id: "other", role: "teacher" as const };
    const student = { id: "s", role: "student" as const };

    expect(canAdministerClassroom({ classroom, user: owner })).toBe(true);
    expect(canAdministerClassroom({ classroom, user: other })).toBe(true);
    expect(canAdministerClassroom({ classroom, user: student })).toBe(false);

    expect(canDeleteClassroom({ classroom, user: owner })).toBe(true);
    expect(canDeleteClassroom({ classroom, user: other })).toBe(false);
    expect(canDeleteClassroom({ classroom, user: student })).toBe(false);
  });

  it("never trusts a client-shaped role string", () => {
    const rogue = { id: "x", role: "admin" as unknown as "student" };
    expect(
      canAdministerClassroom({ classroom: { ownerId: "x" }, user: rogue }),
    ).toBe(false);
  });
});

describe("batch classroom membership", () => {
  it("refuses a student who asks to administer the classroom", async () => {
    const { classroom, cohortStudent, outsider } = await seedCohort();

    await expect(
      addClassroomMembersBatch(testDb, {
        classroomId: classroom.id,
        actorId: cohortStudent.id,
        userIds: [outsider.id],
      }),
    ).rejects.toBeInstanceOf(MembershipAuthorizationError);

    expect(await listClassroomMembers(testDb, classroom.id)).toHaveLength(1);
  });

  it("adds a mix of ids and pasted addresses, reporting each outcome", async () => {
    const { teacher, classroom, cohortStudent, outsider } = await seedCohort();
    const extra = await createUser(testDb, {
      email: "late@example.com",
      password: "s3cret-password",
      displayName: "Late Joiner",
    });

    const result = await addClassroomMembersBatch(testDb, {
      classroomId: classroom.id,
      actorId: teacher.id,
      userIds: [outsider.id, cohortStudent.id],
      emails: ["late@example.com", "nobody@example.com"],
    });

    expect(result.applied.map((row) => row.id).sort()).toEqual(
      [outsider.id, extra.id].sort(),
    );
    // Already in the classroom: reported, not an error.
    expect(result.skipped.map((row) => row.id)).toEqual([cohortStudent.id]);
    // One typo costs one student, never the batch.
    expect(result.unknownEmails).toEqual(["nobody@example.com"]);
  });

  it("grants every board of the classroom to everyone the batch added", async () => {
    const { teacher, classroom, outsider, board, secondBoard } =
      await seedCohort();

    await addClassroomMembersBatch(testDb, {
      classroomId: classroom.id,
      actorId: teacher.id,
      userIds: [outsider.id],
    });

    for (const target of [board, secondBoard]) {
      expect(await getBoardAccess(testDb, target.id, outsider.id)).toMatchObject(
        { canView: true, canWrite: true },
      );
    }
  });

  it("revokes every board of the classroom when the batch removes them", async () => {
    const { teacher, classroom, cohortStudent, board, secondBoard } =
      await seedCohort();

    const result = await removeClassroomMembersBatch(testDb, {
      classroomId: classroom.id,
      actorId: teacher.id,
      userIds: [cohortStudent.id],
    });

    expect(result.applied.map((row) => row.id)).toEqual([cohortStudent.id]);
    for (const target of [board, secondBoard]) {
      expect(
        await getBoardAccess(testDb, target.id, cohortStudent.id),
      ).toMatchObject({ canView: false, canWrite: false });
    }
  });

  it("reports an id that matches no account instead of failing", async () => {
    const { teacher, classroom } = await seedCohort();

    const result = await addClassroomMembersBatch(testDb, {
      classroomId: classroom.id,
      actorId: teacher.id,
      userIds: ["00000000-0000-4000-8000-0000000000ff"],
    });

    expect(result.applied).toHaveLength(0);
    expect(result.unknownUserIds).toEqual([
      "00000000-0000-4000-8000-0000000000ff",
    ]);
  });

  it("refuses to touch a classroom that does not exist", async () => {
    const { teacher, outsider } = await seedCohort();

    await expect(
      addClassroomMembersBatch(testDb, {
        classroomId: "00000000-0000-4000-8000-000000000000",
        actorId: teacher.id,
        userIds: [outsider.id],
      }),
    ).rejects.toThrow();
  });
});
