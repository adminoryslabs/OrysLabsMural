import { requireTeacher } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { listIconCatalog } from "@/lib/icons/icons";
import { CreateIconForm } from "./create-icon-form";

export const dynamic = "force-dynamic";

export default async function IconsPage() {
  await requireTeacher();
  const icons = await listIconCatalog(db);

  return (
    <main className="app-main">
      <div className="container">
        <h1>Icons</h1>
        <p className="muted">
          The doodle icon bank every board&apos;s icon picker draws from. Adding
          one here makes it available on every board immediately — no deploy.
        </p>

        <div className="card">
          <h2>New icon</h2>
          <CreateIconForm />
        </div>

        <div className="card">
          <h2>Catalog ({icons.length})</h2>
          {icons.length === 0 ? (
            <p className="muted">No icons yet — add the first one above.</p>
          ) : (
            <div className="icon-picker-grid">
              {icons.map((icon) => (
                <div key={icon.fileId} className="icon-picker-item">
                  <img
                    src={`/api/icons/${icon.fileId}`}
                    alt=""
                    width={36}
                    height={36}
                  />
                  <span>{icon.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
