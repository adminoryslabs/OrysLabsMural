"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import {
  clearSessionCookie,
  readSessionToken,
  setSessionCookie,
} from "@/lib/auth/cookies";
import { createSession, invalidateSession } from "@/lib/auth/session";
import { verifyCredentials } from "@/lib/auth/users";
import { db } from "@/lib/db";

export interface LoginFormState {
  error?: string;
}

const loginSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(200),
  next: z.string().optional(),
});

/** Only internal paths are accepted as a post-login destination. */
function safeNextPath(value: string | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

export async function loginAction(
  _previous: LoginFormState,
  formData: FormData,
): Promise<LoginFormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });

  if (!parsed.success) {
    return { error: "Enter your email and password." };
  }

  const user = await verifyCredentials(
    db,
    parsed.data.email,
    parsed.data.password,
  );

  // One message for both cases: never reveal whether the email exists.
  if (!user) {
    return { error: "Invalid email or password." };
  }

  const { token, session } = await createSession(db, user.id);
  await setSessionCookie(token, session.expiresAt);

  const target =
    safeNextPath(parsed.data.next) ??
    (user.role === "teacher" ? "/teacher" : "/boards");
  redirect(target);
}

export async function logoutAction(): Promise<void> {
  const token = await readSessionToken();
  if (token) {
    await invalidateSession(db, token);
  }
  await clearSessionCookie();
  redirect("/login");
}
