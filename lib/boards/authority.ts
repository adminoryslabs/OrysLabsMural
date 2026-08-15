import type { BoardStatus, UserRole } from "@/lib/db/schema";

/**
 * The minimum a caller must know to decide access. Deliberately narrow so the
 * rules can be reasoned about (and tested) without touching the database.
 *
 * Both inputs MUST come from the database. A role or status that arrived in a
 * request body is not an input to these functions.
 */
export interface BoardAuthorityInput {
  board: { id: string; ownerId: string; status: BoardStatus };
  user: { id: string; role: UserRole };
  isMember: boolean;
}

function isTeacher(role: UserRole): boolean {
  // Explicit comparison: any unexpected value is treated as a student.
  return role === "teacher";
}

export function isBoardOwner(input: {
  board: { ownerId: string };
  user: { id: string };
}): boolean {
  return input.board.ownerId === input.user.id;
}

/**
 * Read access. Teachers supervise every board in the course; students only see
 * the boards they were assigned to.
 */
export function canViewBoard(input: BoardAuthorityInput): boolean {
  if (isTeacher(input.user.role)) return true;
  return input.isMember;
}

/**
 * Write access. This is THE authority: the Phase B websocket server calls it
 * (through `getBoardAccess`) on every handshake and rejects updates when it
 * returns false.
 *
 *   active   - members and teachers may write
 *   readonly - only teachers may write; students observe
 *   frozen   - nobody may write, not even the owner. Freezing is meant to stop
 *              the class dead, so it deliberately outranks ownership.
 */
export function canWriteToBoard(input: BoardAuthorityInput): boolean {
  if (input.board.status === "frozen") return false;
  if (isTeacher(input.user.role)) return true;
  if (input.board.status === "readonly") return false;
  return input.board.status === "active" && input.isMember;
}

/** Administrative actions on a board: membership, status, renaming. */
export function canAdministerBoard(input: {
  board: { ownerId: string };
  user: { id: string; role: UserRole };
}): boolean {
  return isTeacher(input.user.role);
}

/** Destroying class material is restricted to the teacher who owns the board. */
export function canDeleteBoard(input: {
  board: { ownerId: string };
  user: { id: string; role: UserRole };
}): boolean {
  return isTeacher(input.user.role) && isBoardOwner(input);
}
