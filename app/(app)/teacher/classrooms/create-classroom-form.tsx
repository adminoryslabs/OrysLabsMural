"use client";

import { useActionState, useRef } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "../actions";
import { createClassroomAction } from "../classroom-actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button className="btn-solid" type="submit" disabled={pending}>
      {pending ? "Creating…" : "Create classroom"}
    </button>
  );
}

export function CreateClassroomForm() {
  const [state, formAction] = useActionState<ActionState, FormData>(
    createClassroomAction,
    {},
  );
  const inputRef = useRef<HTMLInputElement>(null);

  return (
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
          <label htmlFor="classroom-name">Classroom name</label>
          <input
            ref={inputRef}
            id="classroom-name"
            name="name"
            type="text"
            required
            maxLength={120}
            placeholder="Software Architecture — 2026 cohort"
          />
        </div>
        <SubmitButton />
      </div>
    </form>
  );
}
