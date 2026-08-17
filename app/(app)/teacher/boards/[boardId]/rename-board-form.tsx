"use client";

import { useActionState } from "react";
import { renameBoardAction, type ActionState } from "../../actions";

export function RenameBoardForm({
  boardId,
  title,
}: {
  boardId: string;
  title: string;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    renameBoardAction,
    {},
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="boardId" value={boardId} />

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
          <label htmlFor="board-rename">Board title</label>
          <input
            id="board-rename"
            name="title"
            type="text"
            required
            maxLength={120}
            defaultValue={title}
          />
        </div>
        <button className="btn-solid" type="submit" disabled={pending}>
          {pending ? "Saving…" : "Rename"}
        </button>
      </div>
    </form>
  );
}
