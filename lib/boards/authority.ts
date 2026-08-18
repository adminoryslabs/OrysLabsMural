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
  /**
   * An explicit row in `board_members`. The ADDITIVE exception: a teaching
   * assistant, or a guest who is not in the cohort. It only ever grants; it
   * never removes what the classroom already granted.
   */
  isMember: boolean;
  /**
   * The user belongs to the classroom this board is assigned to. Optional and
   * fail-closed on purpose: a caller that has not looked the classroom up
   * grants nothing, which is the safe direction to be wrong in.
   */
  isClassroomMember?: boolean;
}

/**
 * The plain role check, exported for callers with no board in the picture at
 * all — the global icon catalog's upload gate, for one. Every board-scoped
 * function below is built on top of this same primitive.
 */
export function isTeacher(role: UserRole): boolean {
  // Explicit comparison: any unexpected value is treated as a student.
  return role === "teacher";
}

/**
 * The two membership paths, unified. They are a UNION, never an intersection:
 * the classroom is the source of truth, and `board_members` is the escape
 * hatch bolted next to it.
 */
function belongsToBoard(input: BoardAuthorityInput): boolean {
  return input.isMember === true || input.isClassroomMember === true;
}

export function isBoardOwner(input: {
  board: { ownerId: string };
  user: { id: string };
}): boolean {
  return input.board.ownerId === input.user.id;
}

/**
 * Read access. Teachers supervise every board in the course; students see the
 * boards of their classroom, plus any board they were listed on explicitly.
 */
export function canViewBoard(input: BoardAuthorityInput): boolean {
  if (isTeacher(input.user.role)) return true;
  return belongsToBoard(input);
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
 *
 * STATUS OUTRANKS BOTH MEMBERSHIP PATHS. The status checks come first and are
 * unconditional, so belonging to the classroom buys exactly as much on a frozen
 * board as being listed in `board_members` does: nothing.
 */
export function canWriteToBoard(input: BoardAuthorityInput): boolean {
  if (input.board.status === "frozen") return false;
  if (isTeacher(input.user.role)) return true;
  if (input.board.status === "readonly") return false;
  return input.board.status === "active" && belongsToBoard(input);
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
