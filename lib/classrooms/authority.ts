import type { UserRole } from "@/lib/db/schema";

/**
 * Who may administer a cohort.
 *
 * A classroom is an access-granting object: its roster is what opens every
 * board assigned to it. So the rules mirror the board rules exactly rather than
 * inventing a second vocabulary — administering is any teacher's job, and
 * destroying is the owner's alone.
 *
 * As with boards, the role MUST come from the database row. A role that
 * arrived in a request body is not an input to these functions.
 */

function isTeacher(role: UserRole): boolean {
  // Explicit comparison: any unexpected value is treated as a student.
  return role === "teacher";
}

export function isClassroomOwner(input: {
  classroom: { ownerId: string };
  user: { id: string };
}): boolean {
  return input.classroom.ownerId === input.user.id;
}

/** Renaming, and adding or removing students. Any teacher. */
export function canAdministerClassroom(input: {
  classroom: { ownerId: string };
  user: { id: string; role: UserRole };
}): boolean {
  return isTeacher(input.user.role);
}

/**
 * Deleting a cohort. Restricted to the teacher who created it, like deleting a
 * board: it detaches every board of the classroom at once, which is the widest
 * single access change in the product.
 */
export function canDeleteClassroom(input: {
  classroom: { ownerId: string };
  user: { id: string; role: UserRole };
}): boolean {
  return isTeacher(input.user.role) && isClassroomOwner(input);
}
