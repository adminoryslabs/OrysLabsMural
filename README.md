# OrysLabs Mural

Self-hosted collaborative whiteboard for software architecture classes.
Next.js (App Router) + TypeScript, PostgreSQL 17 + Drizzle, deployed with Docker
Compose behind Caddy.

**Phase A (this repository state)** delivers the foundation: authentication,
the teacher panel, the data model and the participation log.
**Phase B** adds the Excalidraw canvas and the Yjs websocket server; the seams
it plugs into are listed at the end of this file.

## Requirements

Node 22+, npm 10+, Docker with Compose v2.

## Run it locally

```bash
cp env.example .env          # the defaults work as-is for local development
docker compose up -d         # Postgres 17 on localhost:5433
npm install
npm run db:migrate           # apply SQL migrations
npm run db:seed              # create the teacher + student accounts
npm run dev                  # http://localhost:3000
```

`npm run db:seed` prints the generated credentials and writes them to
`seed-credentials.csv` (gitignored). Hand them out, then delete the file.

To use real student names, copy `scripts/roster.example.csv` to
`scripts/roster.csv` and edit it. Without a roster file the script generates
`SEED_STUDENT_COUNT` accounts named `student01@…`. Re-running the seed never
touches an existing account, so it is safe mid-course.

## Tests

```bash
docker compose up -d         # tests need a real Postgres
npm test
```

The suite runs against a real PostgreSQL database (`mural_test`), recreated and
migrated on every run. The database layer is never mocked.

## Other commands

| Command               | What it does                                         |
| --------------------- | ---------------------------------------------------- |
| `npm run db:generate` | Generate a migration after editing `lib/db/schema.ts` |
| `npm run db:migrate`  | Apply pending migrations                              |
| `npm run typecheck`   | `tsc --noEmit`                                        |
| `npm run lint`        | ESLint                                                |
| `npm run build`       | Production build                                      |

Migrations are generated and reviewed, never pushed: there is no `db:push`.

## Production deployment (VPS)

1. Point the domain's DNS at the VPS.
2. Copy the repository over, then `cp env.example .env` and set at least
   `APP_DOMAIN`, `ACME_EMAIL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`.
3. Start the stack:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Caddy terminates TLS with automatic certificates. The `migrate` service applies
migrations and exits before the app starts. Only Caddy publishes ports.

Seed the production database once the stack is up:

```bash
docker compose -f docker-compose.prod.yml run --rm \
  -e SEED_STUDENT_COUNT=25 migrate npx tsx scripts/seed.ts
```

## Domain model

| Table             | Purpose                                                     |
| ----------------- | ----------------------------------------------------------- |
| `users`           | Accounts. Role is `teacher` or `student`. No public signup.  |
| `boards`          | A whiteboard. `status` is the server-side write authority.   |
| `board_members`   | Who is assigned to a board (composite PK).                   |
| `board_sessions`  | Participation log: one row per websocket connection.         |
| `board_snapshots` | Yjs document state (`bytea`), append-only.                   |
| `sessions`        | Auth sessions. The stored id is a SHA-256 of the cookie token.|

### Board status is the authority

| Status     | Teachers   | Members    | Everyone else |
| ---------- | ---------- | ---------- | ------------- |
| `active`   | read/write | read/write | no access     |
| `readonly` | read/write | read only  | no access     |
| `frozen`   | read only  | read only  | no access     |

`frozen` deliberately outranks ownership: freezing stops the class dead,
including the teacher. The rules live in `lib/boards/authority.ts` as pure
functions and are exercised by `tests/boards/authority.test.ts`.

Nothing that arrives from a client is ever an input to those rules. Role and
status are always read from the database first (`getBoardAccess`), and every
server action re-authorises through `requireTeacher()` — a rendered button is
not permission.

### Attribution

`board_sessions` answers "which boards did student X take part in, and how
much" without any later schema change:

- presence time: `coalesce(disconnected_at, last_seen_at) - connected_at`
- contribution: `edit_count`
- engagement: session count, first and last seen

`last_seen_at` is what keeps this honest: a tab that dies without a clean
disconnect stops accruing time at its last heartbeat instead of forever. Query
helpers are in `lib/participation/queries.ts`
(`getUserParticipation`, `getBoardParticipation`). The teacher's board page
already renders the per-board table; a full analytics dashboard is out of scope
for Phase A but needs no migration.

## Layout

```
app/                 Routes. (app)/ is the authenticated shell.
components/          Shared UI, including the canvas placeholder.
lib/auth/            Passwords, sessions, cookies, guards.
lib/boards/          Board authority rules, queries, Yjs snapshots.
lib/participation/   The participation/attribution log.
lib/db/              Drizzle schema and client.
drizzle/             Generated SQL migrations.
scripts/             migrate.ts, seed.ts.
tests/               Vitest suites against a real Postgres.
```

---

## Phase B: the seams to plug into

Phase B owns the Excalidraw canvas and the Yjs websocket server. Everything it
needs already exists; do not re-derive any of it.

### 1. Replace the canvas placeholder

`components/board-canvas-placeholder.tsx`, mounted by
`app/(app)/boards/[boardId]/page.tsx`. The page already resolves and passes
`boardId` (use it as the Yjs room name), `canWrite` and `status`. Treat
`canWrite` as a UI hint only — the server re-checks.

### 2. Board status — source of truth

```ts
import { getBoardAccess } from "@/lib/boards/queries";

const access = await getBoardAccess(db, boardId, userId);
// null              -> board does not exist
// access.canView    -> may open/subscribe to the room
// access.canWrite   -> may apply updates
// access.board.status, access.isMember, access.role
```

One round trip: board row + membership + role from the database, then the pure
rules. Call it on every handshake and re-check on write. Never cache the verdict
across a status change — the teacher can freeze a board mid-class, and the
freeze must take effect on the next update, so re-read at least per write batch
(or subscribe to a Postgres `NOTIFY` if that proves too chatty).

### 3. Authenticating a websocket connection

The browser sends the `mural_session` cookie on the websocket upgrade request
(same origin; Caddy proxies `/yjs` on the same domain — see the commented block
in `Caddyfile`). On the server:

```ts
import { validateSessionToken } from "@/lib/auth/session";
import { SESSION_COOKIE_NAME } from "@/lib/auth/cookies"; // "mural_session"

// parse the raw Cookie header of the upgrade request yourself:
// lib/auth/cookies.ts uses next/headers and is Next-only.
const { user } = await validateSessionToken(db, token);
if (!user) socket.close(); // reject the upgrade
```

`validateSessionToken` hashes the token, checks expiry, deletes expired rows and
returns the user with the role read from the database. It takes an explicit
`Database`, so it works outside Next.js. Reject the upgrade before joining a
room; never accept a user id sent by the client.

### 4. Writing the participation log

```ts
import {
  startBoardSession,
  recordBoardActivity,
  endBoardSession,
  closeStaleBoardSessions,
} from "@/lib/participation/queries";

const session = await startBoardSession(db, { boardId, userId, connectionId });
await recordBoardActivity(db, session.id, { edits: n });   // heartbeat, ~15-30s
await endBoardSession(db, session.id);                     // on close
await closeStaleBoardSessions(db, { staleAfterSeconds: 120 }); // periodic job
```

The heartbeat is not optional: it is what bounds a session that never closes
cleanly. One row per connection, so multiple tabs stay distinguishable.

### 5. Persisting the document

```ts
import {
  saveBoardSnapshot,
  getLatestBoardSnapshot,
  pruneBoardSnapshots,
} from "@/lib/boards/snapshots";

const snapshot = await getLatestBoardSnapshot(db, boardId); // on first join
if (snapshot) Y.applyUpdate(doc, snapshot.state);

await saveBoardSnapshot(db, boardId, Y.encodeStateAsUpdate(doc)); // debounced
await pruneBoardSnapshots(db, boardId, 20);
```

Append-only, so a corrupted board can be rolled back. Call
`touchBoard(db, boardId)` after a save to keep `boards.updated_at` meaningful.

### 6. Infrastructure already prepared

- `docker-compose.prod.yml` contains a commented `yjs` service (build context
  `./yjs-server`, port 1234) — fill it in and uncomment.
- `Caddyfile` contains the matching commented `/yjs*` reverse proxy block.
- `NEXT_PUBLIC_YJS_URL` is already wired through the compose environment.
