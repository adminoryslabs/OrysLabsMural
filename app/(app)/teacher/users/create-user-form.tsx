"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { createUserAction, type ActionState } from "../actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button className="primary" type="submit" disabled={pending}>
      {pending ? "Creating..." : "Create account"}
    </button>
  );
}

export function CreateUserForm() {
  const [state, formAction] = useActionState<ActionState, FormData>(
    createUserAction,
    {},
  );

  return (
    <form action={formAction}>
      {state.error ? <p className="error">{state.error}</p> : null}
      {state.message ? <p className="muted">{state.message}</p> : null}

      <label htmlFor="displayName">Display name</label>
      <input id="displayName" name="displayName" type="text" required />

      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" required />

      <label htmlFor="password">Initial password (minimum 8 characters)</label>
      <input id="password" name="password" type="text" required minLength={8} />

      <label htmlFor="role">Role</label>
      <select id="role" name="role" defaultValue="student">
        <option value="student">student</option>
        <option value="teacher">teacher</option>
      </select>

      <SubmitButton />
    </form>
  );
}
