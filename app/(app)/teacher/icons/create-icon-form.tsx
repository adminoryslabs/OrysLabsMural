"use client";

import { useActionState, useRef } from "react";
import { useFormStatus } from "react-dom";
import { createIconAction, type ActionState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button className="primary" type="submit" disabled={pending}>
      {pending ? "Adding..." : "Add icon"}
    </button>
  );
}

export function CreateIconForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction] = useActionState<ActionState, FormData>(
    async (previous, formData) => {
      const result = await createIconAction(previous, formData);
      if (!result.error) formRef.current?.reset();
      return result;
    },
    {},
  );

  return (
    <form ref={formRef} action={formAction}>
      {state.error ? <p className="error">{state.error}</p> : null}
      {state.message ? <p className="muted">{state.message}</p> : null}

      <label htmlFor="name">Name</label>
      <input
        id="name"
        name="name"
        type="text"
        placeholder="rocket"
        pattern="[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?"
        required
      />
      <p className="muted">
        Lowercase, digits and hyphens only. This is the id a board scene refers
        to the icon by.
      </p>

      <label htmlFor="label">Label</label>
      <input id="label" name="label" type="text" placeholder="Rocket" required />

      <label htmlFor="file">Image (PNG, JPEG, WEBP or GIF)</label>
      <input id="file" name="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" required />

      <SubmitButton />
    </form>
  );
}
