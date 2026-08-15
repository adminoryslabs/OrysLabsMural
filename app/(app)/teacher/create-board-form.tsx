"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { createBoardAction, type ActionState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button className="primary" type="submit" disabled={pending}>
      {pending ? "Creating..." : "Create board"}
    </button>
  );
}

export function CreateBoardForm() {
  const [state, formAction] = useActionState<ActionState, FormData>(
    createBoardAction,
    {},
  );

  return (
    <form action={formAction}>
      {state.error ? <p className="error">{state.error}</p> : null}
      {state.message ? <p className="muted">{state.message}</p> : null}
      <label htmlFor="title">Board title</label>
      <input id="title" name="title" type="text" required maxLength={120} />
      <SubmitButton />
    </form>
  );
}
