import { redirect } from "next/navigation";
import {
  AcUnitIcon,
  GroupsIcon,
  HistoryIcon,
} from "@/components/icons";
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
    <div className="landing">
      <header className="landing-header">
        <span className="brand-mark" aria-hidden="true" />
        <span className="wordmark">OrysLabs Mural</span>
        <span className="landing-header-suffix">Academy</span>
      </header>

      <main className="landing-body">
        <div className="landing-pitch">
          <h1>One whiteboard, the whole class on it.</h1>
          <p className="landing-lede">
            Your instructor opens a board, everyone draws on the same canvas at
            once, and nothing gets lost between classes.
          </p>

          <div className="landing-features">
            <p className="landing-feature">
              <GroupsIcon size={19} />
              Live cursors and shapes, no refreshing.
            </p>
            <p className="landing-feature">
              <AcUnitIcon size={19} />
              The instructor can freeze the room in one click.
            </p>
            <p className="landing-feature">
              <HistoryIcon size={19} />
              Boards are saved, and your work is credited to you.
            </p>
          </div>
        </div>

        <LoginForm next={next} />
      </main>

      <footer className="landing-footer">Self-hosted by OrysLabs · 2026</footer>
    </div>
  );
}
