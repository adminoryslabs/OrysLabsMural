"use client";

import { useActionState } from "react";
import type { ActionState } from "../../actions";
import { renameClassroomAction } from "../../classroom-actions";

export function RenameClassroomForm({
  classroomId,
  name,
}: {
  classroomId: string;
  name: string;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    renameClassroomAction,
    {},
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="classroomId" value={classroomId} />

      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.message ? (
        <p className="muted" role="status">
          {state.message}
        </p>
      ) : null}

      <div className="form-inline-field">
        <div>
          <label htmlFor="classroom-rename">Classroom name</label>
          <input
            id="classroom-rename"
            name="name"
            type="text"
            required
            maxLength={120}
            defaultValue={name}
          />
        </div>
        <button className="btn-solid" type="submit" disabled={pending}>
          {pending ? "Saving…" : "Rename"}
        </button>
      </div>
    </form>
  );
}
