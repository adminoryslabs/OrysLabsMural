"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { createBoardAction, type ActionState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button className="btn-solid" type="submit" disabled={pending}>
      {pending ? "Creating…" : "Create board"}
    </button>
  );
}

/**
 * The creation form, revealed by the "New board" button in the dashboard
 * header. It is a panel rather than a modal: nothing about naming a board
 * warrants taking the class listing away from the teacher.
 */
export function CreateBoardForm({ onDone }: { onDone?: () => void }) {
  const [state, formAction] = useActionState<ActionState, FormData>(
    createBoardAction,
    {},
  );
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="card create-board">
      <form action={formAction}>
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
            <label htmlFor="title">Board title</label>
            <input
              ref={inputRef}
              id="title"
              name="title"
              type="text"
              required
              maxLength={120}
              placeholder="Hexagonal architecture — group A"
            />
          </div>
          <SubmitButton />
          {onDone ? (
            <button className="btn-quiet" type="button" onClick={onDone}>
              Close
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
