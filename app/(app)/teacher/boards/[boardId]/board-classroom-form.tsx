"use client";

import { useActionState } from "react";
import { setBoardClassroomAction } from "../../classroom-actions";
import type { ActionState } from "../../actions";

export interface ClassroomOption {
  id: string;
  name: string;
  memberCount: number;
}

/**
 * Assigns the board to a cohort, or clears the assignment.
 *
 * The select is the whole control on purpose: assigning and un-assigning are
 * the same decision, and a separate "clear" button would only invite the
 * teacher to hunt for it. The server validates the id against the database
 * before it writes — this list is a convenience, never the authority.
 */
export function BoardClassroomForm({
  boardId,
  classroomId,
  classrooms,
}: {
  boardId: string;
  classroomId: string | null;
  classrooms: readonly ClassroomOption[];
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    setBoardClassroomAction,
    {},
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="boardId" value={boardId} />

      {state.error ? <p className="error">{state.error}</p> : null}
      {state.message ? (
        <p className="muted" role="status">
          {state.message}
        </p>
      ) : null}

      <div className="row classroom-picker">
        <label>
          <span className="sr-only">Classroom</span>
          <select
            name="classroomId"
            defaultValue={classroomId ?? ""}
            disabled={classrooms.length === 0}
          >
            <option value="">No classroom</option>
            {classrooms.map((classroom) => (
              <option key={classroom.id} value={classroom.id}>
                {classroom.name} ({classroom.memberCount})
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          type="submit"
          disabled={pending || classrooms.length === 0}
        >
          {pending ? "Saving…" : "Save classroom"}
        </button>
      </div>
    </form>
  );
}
