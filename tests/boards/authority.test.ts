import { describe, expect, it } from "vitest";
import {
  canAdministerBoard,
  canDeleteBoard,
  canViewBoard,
  canWriteToBoard,
} from "@/lib/boards/authority";
import type { BoardStatus } from "@/lib/db/schema";

const OWNER_ID = "00000000-0000-0000-0000-0000000000a1";
const OTHER_TEACHER_ID = "00000000-0000-0000-0000-0000000000a2";
const MEMBER_ID = "00000000-0000-0000-0000-0000000000b1";
const OUTSIDER_ID = "00000000-0000-0000-0000-0000000000b2";

function board(status: BoardStatus) {
  return { id: "board-1", ownerId: OWNER_ID, status };
}

const owner = { id: OWNER_ID, role: "teacher" as const };
const otherTeacher = { id: OTHER_TEACHER_ID, role: "teacher" as const };
const member = { id: MEMBER_ID, role: "student" as const };
const outsider = { id: OUTSIDER_ID, role: "student" as const };

describe("canViewBoard", () => {
  it("lets a member view an active board", () => {
    expect(
      canViewBoard({ board: board("active"), user: member, isMember: true }),
    ).toBe(true);
  });

  it("keeps a non-member student out", () => {
    expect(
      canViewBoard({ board: board("active"), user: outsider, isMember: false }),
    ).toBe(false);
  });

  it("lets any teacher view any board, member or not", () => {
    expect(
      canViewBoard({
        board: board("active"),
        user: otherTeacher,
        isMember: false,
      }),
    ).toBe(true);
  });

  it("keeps view access on frozen and readonly boards", () => {
    for (const status of ["frozen", "readonly"] as const) {
      expect(
        canViewBoard({ board: board(status), user: member, isMember: true }),
      ).toBe(true);
    }
  });
});

describe("canWriteToBoard", () => {
  it("lets a member write to an active board", () => {
    expect(
      canWriteToBoard({ board: board("active"), user: member, isMember: true }),
    ).toBe(true);
  });

  it("refuses a non-member student even on an active board", () => {
    expect(
      canWriteToBoard({
        board: board("active"),
        user: outsider,
        isMember: false,
      }),
    ).toBe(false);
  });

  it("refuses everyone on a frozen board, including the owner", () => {
    const frozen = board("frozen");
    expect(canWriteToBoard({ board: frozen, user: owner, isMember: true })).toBe(
      false,
    );
    expect(
      canWriteToBoard({ board: frozen, user: otherTeacher, isMember: false }),
    ).toBe(false);
    expect(
      canWriteToBoard({ board: frozen, user: member, isMember: true }),
    ).toBe(false);
  });

  it("on a readonly board lets teachers write but not students", () => {
    const readonly = board("readonly");
    expect(
      canWriteToBoard({ board: readonly, user: owner, isMember: true }),
    ).toBe(true);
    expect(
      canWriteToBoard({ board: readonly, user: otherTeacher, isMember: false }),
    ).toBe(true);
    expect(
      canWriteToBoard({ board: readonly, user: member, isMember: true }),
    ).toBe(false);
  });

  it("never trusts a client-shaped role string", () => {
    // A caller passing an unexpected role must not be granted teacher powers.
    const rogue = { id: OUTSIDER_ID, role: "admin" as unknown as "student" };
    expect(
      canWriteToBoard({
        board: board("readonly"),
        user: rogue,
        isMember: true,
      }),
    ).toBe(false);
  });
});

describe("canAdministerBoard", () => {
  it("is true for any teacher and false for any student", () => {
    expect(canAdministerBoard({ board: board("active"), user: owner })).toBe(
      true,
    );
    expect(
      canAdministerBoard({ board: board("active"), user: otherTeacher }),
    ).toBe(true);
    expect(canAdministerBoard({ board: board("active"), user: member })).toBe(
      false,
    );
  });
});

describe("canDeleteBoard", () => {
  it("is restricted to the owning teacher", () => {
    expect(canDeleteBoard({ board: board("active"), user: owner })).toBe(true);
    expect(canDeleteBoard({ board: board("active"), user: otherTeacher })).toBe(
      false,
    );
    expect(canDeleteBoard({ board: board("active"), user: member })).toBe(false);
  });
});
