"use client";

import { deleteClassroomAction } from "../../classroom-actions";

/**
 * Deleting a classroom revokes every board of that classroom for everybody in
 * it, in one click. It is the widest single access change in the product, so it
 * asks first — and it says how many boards it is about to detach, because that
 * number is the whole consequence.
 */
export function DeleteClassroomForm({
  classroomId,
  boardCount,
}: {
  classroomId: string;
  boardCount: number;
}) {
  return (
    <form
      action={deleteClassroomAction}
      onSubmit={(event) => {
        const detached =
          boardCount === 1 ? "1 board" : `${boardCount} boards`;
        if (
          !window.confirm(
            `Delete this classroom? ${detached} will stay but become unassigned, and its students will lose access to them.`,
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="classroomId" value={classroomId} />
      <button className="danger" type="submit">
        Delete classroom
      </button>
    </form>
  );
}
