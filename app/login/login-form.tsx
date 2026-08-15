"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { ArrowForwardIcon } from "@/components/icons";
import { loginAction, type LoginFormState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button className="btn-solid" type="submit" disabled={pending}>
      {pending ? "Signing in…" : "Sign in"}
      {pending ? null : <ArrowForwardIcon size={18} />}
    </button>
  );
}

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction] = useActionState<LoginFormState, FormData>(
    loginAction,
    {},
  );

  return (
    <form className="landing-form" action={formAction}>
      <h2>Sign in</h2>
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <label htmlFor="email">Email</label>
      <input
        id="email"
        name="email"
        type="email"
        placeholder="ada@oryslabs.com"
        autoComplete="username"
        required
      />

      <label htmlFor="password">Password</label>
      <input
        id="password"
        name="password"
        type="password"
        placeholder="••••••••••"
        autoComplete="current-password"
        required
      />

      {/* The failure belongs next to the control that produced it. */}
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}

      <SubmitButton />

      <p className="landing-footnote">
        Accounts are created by your instructor. There is no public sign-up —
        ask in class if you do not have one.
      </p>
    </form>
  );
}
