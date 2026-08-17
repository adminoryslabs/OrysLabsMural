import { beforeEach, describe, expect, it } from "vitest";
import { createUser } from "@/lib/auth/users";
import { addBoardMember, listBoardMembers } from "@/lib/boards/queries";
import {
  MembershipAuthorizationError,
  addBoardMembersBatch,
  parseEmailList,
  removeBoardMembersBatch,
} from "@/lib/boards/membership";
import { resetDatabase, testDb } from "../setup/db";
import { seedBoardWithMember } from "../setup/fixtures";

beforeEach(async () => {
  await resetDatabase();
});

describe("parseEmailList", () => {
  it("accepts newlines, commas and semicolons in the same paste", () => {
    expect(
      parseEmailList("ada@example.com, grace@example.com\nalan@example.com"),
    ).toEqual(["ada@example.com", "grace@example.com", "alan@example.com"]);
  });

  it("normalises case and whitespace and drops duplicates", () => {
    expect(parseEmailList("  Ada@Example.COM \n ada@example.com \n\n")).toEqual([
      "ada@example.com",
    ]);
  });

  it("returns nothing for an empty paste", () => {
    expect(parseEmailList("   \n , ; \n")).toEqual([]);
  });
});

describe("addBoardMembersBatch", () => {
  it("adds every matching account in one action", async () => {
    const { teacher, board } = await seedBoardWithMember("active");
    const first = await createUser(testDb, {
      email: "batch-one@example.com",
      password: "s3cret-password",
      displayName: "Batch One",
    });
    const second = await createUser(testDb, {
      email: "batch-two@example.com",
      password: "s3cret-password",
      displayName: "Batch Two",
    });

    const result = await addBoardMembersBatch(testDb, {
      boardId: board.id,
      actorId: teacher.id,
      userIds: [first.id, second.id],
    });

    expect(result.applied.map((row) => row.email)).toEqual([
      "batch-one@example.com",
      "batch-two@example.com",
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.unknownEmails).toEqual([]);

    const members = await listBoardMembers(testDb, board.id);
    expect(members.map((member) => member.id)).toContain(first.id);
    expect(members.map((member) => member.id)).toContain(second.id);
  });

  it("reports matched, already-member and unknown emails separately", async () => {
    const { teacher, student, board } = await seedBoardWithMember("active");
    const newcomer = await createUser(testDb, {
      email: "newcomer@example.com",
      password: "s3cret-password",
      displayName: "Newcomer",
    });

    const result = await addBoardMembersBatch(testDb, {
      boardId: board.id,
      actorId: teacher.id,
      emails: [
        "NEWCOMER@example.com",
        student.email,
        "ghost@example.com",
        "not-an-email",
      ],
    });

    expect(result.applied.map((row) => row.id)).toEqual([newcomer.id]);
    expect(result.skipped.map((row) => row.id)).toEqual([student.id]);
    expect(result.unknownEmails).toEqual(["ghost@example.com", "not-an-email"]);

    // One bad address must never cost the whole batch.
    const members = await listBoardMembers(testDb, board.id);
    expect(members).toHaveLength(2);
  });

  it("merges ids and emails and never inserts the same user twice", async () => {
    const { teacher, board } = await seedBoardWithMember("active");
    const user = await createUser(testDb, {
      email: "both-ways@example.com",
      password: "s3cret-password",
      displayName: "Both Ways",
    });

    const result = await addBoardMembersBatch(testDb, {
      boardId: board.id,
      actorId: teacher.id,
      userIds: [user.id],
      emails: ["both-ways@example.com"],
    });

    expect(result.applied.map((row) => row.id)).toEqual([user.id]);
    const members = await listBoardMembers(testDb, board.id);
    expect(members.filter((member) => member.id === user.id)).toHaveLength(1);
  });

  it("ignores forged user ids instead of failing the batch", async () => {
    const { teacher, board } = await seedBoardWithMember("active");
    const real = await createUser(testDb, {
      email: "real@example.com",
      password: "s3cret-password",
      displayName: "Real Account",
    });
    const forged = "00000000-0000-4000-8000-000000000000";

    const result = await addBoardMembersBatch(testDb, {
      boardId: board.id,
      actorId: teacher.id,
      userIds: [real.id, forged],
    });

    expect(result.applied.map((row) => row.id)).toEqual([real.id]);
    expect(result.unknownUserIds).toEqual([forged]);
  });

  it("refuses a student, whatever the form said", async () => {
    const { student, outsider, board } = await seedBoardWithMember("active");

    await expect(
      addBoardMembersBatch(testDb, {
        boardId: board.id,
        actorId: student.id,
        userIds: [outsider.id],
      }),
    ).rejects.toBeInstanceOf(MembershipAuthorizationError);

    const members = await listBoardMembers(testDb, board.id);
    expect(members.map((member) => member.id)).not.toContain(outsider.id);
  });

  it("refuses a board that does not exist", async () => {
    const { teacher } = await seedBoardWithMember("active");
    await expect(
      addBoardMembersBatch(testDb, {
        boardId: "00000000-0000-4000-8000-000000000000",
        actorId: teacher.id,
        emails: ["someone@example.com"],
      }),
    ).rejects.toThrow(/does not exist/i);
  });
});

describe("removeBoardMembersBatch", () => {
  it("removes several members at once and reports the ones that were not members", async () => {
    const { teacher, student, outsider, board } = await seedBoardWithMember("active");
    const second = await createUser(testDb, {
      email: "second@example.com",
      password: "s3cret-password",
      displayName: "Second Member",
    });
    await addBoardMember(testDb, board.id, second.id);

    const result = await removeBoardMembersBatch(testDb, {
      boardId: board.id,
      actorId: teacher.id,
      userIds: [student.id, second.id, outsider.id],
    });

    expect(result.applied.map((row) => row.id).sort()).toEqual(
      [student.id, second.id].sort(),
    );
    expect(result.skipped.map((row) => row.id)).toEqual([outsider.id]);
    expect(await listBoardMembers(testDb, board.id)).toEqual([]);
  });

  it("removes by pasted email and reports unknown addresses", async () => {
    const { teacher, student, board } = await seedBoardWithMember("active");

    const result = await removeBoardMembersBatch(testDb, {
      boardId: board.id,
      actorId: teacher.id,
      emails: [student.email.toUpperCase(), "ghost@example.com"],
    });

    expect(result.applied.map((row) => row.id)).toEqual([student.id]);
    expect(result.unknownEmails).toEqual(["ghost@example.com"]);
    expect(await listBoardMembers(testDb, board.id)).toEqual([]);
  });

  it("refuses a student, whatever the form said", async () => {
    const { student, board } = await seedBoardWithMember("active");

    await expect(
      removeBoardMembersBatch(testDb, {
        boardId: board.id,
        actorId: student.id,
        userIds: [student.id],
      }),
    ).rejects.toBeInstanceOf(MembershipAuthorizationError);

    const members = await listBoardMembers(testDb, board.id);
    expect(members.map((member) => member.id)).toContain(student.id);
  });
});
