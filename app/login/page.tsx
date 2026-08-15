import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) {
    redirect(user.role === "teacher" ? "/teacher" : "/boards");
  }

  const { next } = await searchParams;

  return (
    <main className="container-narrow">
      <div className="card">
        <h1>OrysLabs Mural</h1>
        <p className="muted">
          Sign in with the credentials your instructor gave you. Accounts are
          created by the instructor; there is no public registration.
        </p>
        <LoginForm next={next} />
      </div>
    </main>
  );
}
