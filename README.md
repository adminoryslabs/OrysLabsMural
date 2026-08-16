# OrysLabs Mural

Self-hosted collaborative whiteboard for software architecture classes.
Next.js (App Router) + TypeScript, PostgreSQL 17 + Drizzle, deployed with Docker
Compose behind Caddy.

Two processes: the Next.js app, and a Yjs websocket server that owns the live
document. They share `lib/`, so the rules about who may write to a board exist
exactly once.

## Requirements

Node 22+, npm 10+, Docker with Compose v2.

## Run it locally

```bash
cp env.example .env          # the defaults work as-is for local development
docker compose up -d         # Postgres 17 on localhost:5433
npm install
npm run db:migrate           # apply SQL migrations
npm run db:seed              # create the teacher + student accounts
npm run dev:all              # app on :3000 + collaboration server on :1234
```

`npm run dev:all` runs both processes. To watch their logs separately, use two
terminals instead:

```bash
npm run dev                  # http://localhost:3000
npm run yjs                  # ws://localhost:1234
```

Both need `DATABASE_URL`. The board page will load without the collaboration
server, but the canvas will sit on "Connecting…" and nothing will sync.

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

`tests/yjs/` boots the real websocket server on an ephemeral port and speaks
the real protocol to it over a real socket, using the same `BoardSession` class
the browser runs. It covers handshake rejection, write refusal on a frozen or
read-only board (including a freeze that lands mid-session), snapshot
round-trips and rehydration after a restart, presence, the whole
`board_sessions` lifecycle, and the live status push — a freeze and a later
unfreeze both reaching a client that never reloads.

`tests/api/` drives the image routes with real `Request` objects, real
multipart bodies and real session cookies. The route files under `app/api/` are
three-line adapters over the handlers those tests call, so the authorisation
under test is the shipped one.

## Other commands

| Command               | What it does                                         |
| --------------------- | ---------------------------------------------------- |
| `npm run dev:all`     | App and collaboration server together                 |
| `npm run yjs`         | Collaboration server only                             |
| `npm run assets`      | Copy Excalidraw's fonts into `public/` (auto on dev/build) |
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
| `board_files`     | Bytes of images pasted onto a board. Keyed by (board, file). |
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

### Assigning a class

Membership is edited in batches, because a dropdown per student is unusable in
front of a class: tick as many people as you like, and/or paste the roster
(newlines, commas and semicolons all work). Adding and removing behave the same
way.

A batch never fails as a whole. Every input is classified and reported back —
added, already a member, unknown address — so one typo costs one student, not
the class. The rules live in `lib/boards/membership.ts`; the insert is a single
`on conflict do nothing … returning`, so "who was already a member" is answered
by Postgres rather than by a read-then-write two teachers could interleave.

Authorisation is not the form's business: the server action re-authenticates
with `requireTeacher()`, and the batch functions then load the board and the
actor's role from the database and run `canAdministerBoard` again for
themselves. Selections that are not even shaped like a uuid are dropped before
they reach SQL.

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

### Fonts and icons

The interface uses Space Grotesk and Inter. Both are vendored as woff2 into
`public/fonts/` and declared in `app/globals.css`, never fetched from Google —
same reason Excalidraw's fonts live in `public/excalidraw/`. Icons are inline
SVG in `components/icons.tsx`, so there is no icon font to load either. The
middleware matcher excludes font extensions on purpose: the landing page is the
one screen an anonymous visitor sees, and redirecting its typeface to `/login`
would render it in the fallback stack.

## Layout

```
app/                 Routes. (app)/ is the authenticated shell, api/ the JSON+bytes one.
components/          Shared UI, including the Excalidraw canvas.
lib/auth/            Passwords, sessions, cookies, guards.
lib/boards/          Board authority rules, queries, Yjs snapshots.
lib/collab/          The browser side of the collaboration link.
lib/participation/   The participation/attribution log.
lib/db/              Drizzle schema and client.
yjs-server/          The websocket server. A separate Node process.
drizzle/             Generated SQL migrations.
scripts/             migrate.ts, seed.ts, excalidraw-assets.ts.
tests/               Vitest suites against a real Postgres.
```

## Realtime collaboration

The canvas is [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT) bound
to a [Yjs](https://github.com/yjs/yjs) CRDT. `yjs-server/` is a plain Node
process that relays updates between clients, persists the document, and decides
who may write. It shares `lib/` with the app on purpose: `getBoardAccess` and
`validateSessionToken` have one implementation, not two.

```
browser ──ws──> yjs-server ──> postgres
   │                              ▲
   └────https──> next.js ─────────┘
```

In production Caddy proxies `/yjs*` on the app's own domain, so the browser
sends the `mural_session` cookie on the upgrade request. That cookie is the
only identity the server accepts.

### The server is the authority

| Frame                 | Checked against the database? |
| --------------------- | ----------------------------- |
| upgrade (handshake)   | yes — session, then `canView` |
| sync step 1 (a read)  | no — the handshake settled it |
| an update (a write)   | **yes, every single time**    |
| awareness (a cursor)  | no — presence is not a write  |
| board status (pushed) | yes — server to client only, re-read per connection |

A write frame costs one indexed query, and that is the point: the teacher can
freeze a board mid-class from the panel, and the freeze has to bite on the very
next update rather than on the next reconnect. There is no cached verdict.

`viewModeEnabled` on the canvas is the UI reflecting the server's answer, never
the enforcement. A student with devtools open who forces a write gets it
dropped, is told why, and has their client resynchronised.

Refusals are deliberately indistinguishable:

| Situation                        | Close code | Reason          |
| -------------------------------- | ---------- | --------------- |
| no cookie / expired / forged      | 4401       | `unauthenticated` |
| board does not exist              | 4404       | `board not found` |
| board exists but is not yours     | 4404       | `board not found` |

That last pair is the same property Phase A's `notFound()` gives the web app:
membership cannot be probed from outside. Codes in 4400-4499 tell the client to
stop reconnecting; a restart closes with 1001 so clients come back.

### Live status: the server tells the clients

A write frame is re-authorised every time, which is enough to make a freeze bite
immediately — but it can never make an **unfreeze** bite, because a client that
has been refused stops sending writes. There are no frames left to check, so
before Phase C a student stayed read-only until they reloaded the page.

So the status is pushed. The collaboration server polls the boards that
currently have a room open (`YJS_STATUS_POLL_MS`, 3s) with **one indexed query
per interval for the whole process** — not one per board, and certainly not one
per connected student. When a board's status has changed, every connection on
that board re-reads `getBoardAccess` and is told, in a frame of its own, the
board's status and whether *it* may write right now.

Polling rather than `LISTEN/NOTIFY`: a poll asks the database what is true
instead of waiting to be told, so it has no failure mode to recover from. A
dropped listener connection, or a status changed by `psql` or a migration rather
than by the app, would leave a whole classroom silently stuck; and nothing a
client does — including saying nothing at all — can defeat a poll. At three
seconds and one query, the cost is not worth a reconnection state machine.

**The pushed status is a hint, never the enforcement.** The websocket server
still re-reads `getBoardAccess` for every single update it receives. A client
that ignores the frame, or forges one, gains nothing: an incoming frame of that
type is classified as "ignored" like any other unknown message. The frame is
server-to-client only.

Nothing reconnects: a status change costs zero new rows in `board_sessions`, and
the browser keeps the same document, the same socket and the same cursor.

### Why a refused write forces a resynchronisation

A CRDT has no concept of a rejected operation. The client applied its change
locally before sending it, so once the server drops it the two documents have
diverged, and every later update from that client references operations the
server never saw — the board would silently stop converging for that user.

So `lib/collab/board-session.ts` treats a refusal as fatal to the local copy:
it throws the document away and takes the server's again. `BoardSession` is
framework-free, and the test suite drives the same class the browser does.

### Persistence

The document is written to `board_snapshots` on a debounce
(`YJS_SNAPSHOT_DEBOUNCE_MS`, 2s) and again when the last client leaves. The
first client to open a board rehydrates it from the newest snapshot, so a
restart of the server loses nothing. History is trimmed to
`YJS_SNAPSHOT_HISTORY` rows, and `boards.updated_at` is touched on every save.

### Attribution

Every accepted connection opens a `board_sessions` row and heartbeats it every
`YJS_HEARTBEAT_MS`. Edits are counted per connection and flushed with the
heartbeat; the row is closed on disconnect, on shutdown, or by the sweeper if a
tab dies silently. A client whose write was refused reconnects, which closes
its row and opens a new one — the same user then shows two sessions, which is
accurate: they were two connections.

### Images

Excalidraw splits an image in two: the element (position, size, `fileId`) and
the bytes. The element is an element like any other and has always synced
through the shared `elements` map. **The bytes deliberately never enter the Yjs
document.** A 2 MB screenshot encoded into the CRDT would be broadcast to all
25 students, rewritten into every `board_snapshots` row on every save, and
downloaded again in full by every late joiner. So only the `fileId` travels —
and it already did.

The bytes go over HTTP instead, into `board_files`:

| Route                                    | Requires   | Why                                                   |
| ---------------------------------------- | ---------- | ----------------------------------------------------- |
| `POST /api/boards/:id/files`             | `canWrite` | Uploading is writing. A frozen or read-only board refuses it. |
| `GET /api/boards/:id/files/:fileId`      | `canView`  | Freezing a board stops writes, not the images on it.  |

Both re-read `getBoardAccess` on every request — there is no cached verdict and
nothing in the request body is an input to the decision, exactly as on the
websocket. Both keep the property that a non-member and a board that does not
exist are the same answer, byte for byte; a missing *file* is that same answer
too, so ids cannot be enumerated either. Uploads record `created_by`, so an
image is as attributable as any other edit.

The primary key is `(board_id, file_id)`: Excalidraw derives `file_id` from the
content, so the same picture on two boards would otherwise be one row shared
across two different authorisation domains. Re-uploading a `file_id` is
idempotent — the same id is the same bytes, and two people pasting the same
screenshot at once must not collide.

**SVG is refused.** An SVG is a document, not a picture: it can carry
`<script>`, and a browser executes that when it renders one served inline from
our own origin — a stored XSS against the whole class, session cookie included.
The allowlist is `png`, `jpeg`, `webp` and `gif`, the format is sniffed from
the bytes rather than taken from the client's `Content-Type` (so an SVG renamed
`.png` is refused too), and downloads carry `nosniff` plus a sandboxing CSP as
a second line. Excalidraw's own shapes stay vectorial regardless; this only
restricts what may be pasted in as an image.

On the client, one pass over the scene uploads what the server does not have
and fetches what this browser is missing, driven by which files the live image
elements reference rather than by any event. An element reaches a peer before
its bytes finish uploading, so a 404 on the way down is expected for a moment
and retried. An upload the server will never accept — too large, wrong format,
board frozen — takes the orphaned element off the canvas and says why, rather
than leaving everyone else with a picture frame that can never load.

### Sticky notes

Excalidraw has no sticky-note tool, and drawing a rectangle then double
clicking to type is four gestures. In a brainstorm where 25 students write 20
notes each, that friction is what decides whether the exercise works. The
button in the board's top bar — or `Shift`+`N` — is two.

The tool lives in **our** chrome, never in Excalidraw's toolbar: no fork, no
patching. It reads `getAppState()` and drops the note at the centre of what the
user is currently looking at (`viewportCoordsToSceneCoords`), never at the
scene origin, which for anyone who has scrolled would put it off screen.

The note is built by Excalidraw's own `convertToExcalidrawElements` from a
skeleton — a solid rounded 180×180 rectangle with a `label`, which is what
creates the bound text container. It is never hand-built: `version`,
`versionNonce` and `seed` are generated by Excalidraw and are exactly what
reconciliation uses to decide whose copy of an element wins. Insertion is a
plain `updateScene`, so the note reaches the class through the same
`onChange` → coalesce → Yjs path a rectangle does. **There is no
synchronisation code specific to sticky notes.** Resizing is native too: a
rectangle with bound text already reflows its text.

`Shift`+`N` was chosen because `n` appears nowhere in Excalidraw's key table —
its tools own the bare digits and `v r d o a l p x t e h f`, and everything
else it binds is behind Ctrl/Cmd or Alt. Requiring Shift keeps us clear of the
bare-letter namespace, which is where Excalidraw adds new tools. The shortcut
is suppressed while any text is being edited, on the event target and on
Excalidraw's own editing state, or a student writing "Anna" into a note would
get a new note for the `n`.

The swatch row sets the colour of the next note and repaints the sticky notes
selected right now — and only those: a rectangle somebody drew by hand is left
alone, because the swatches are the sticky-note tool and not a general fill
picker. Notes are told apart from rectangles by `customData`, which travels
with the element, so every peer agrees without any extra state. The last colour
is remembered per browser in `localStorage`. The rules are pure functions in
`lib/collab/sticky-note.ts`, covered by `tests/collab/sticky-note.test.ts`.

The button and the shortcut are both disabled when the live authority says this
client may not write — and that is a reflection, never the enforcement. The
collaboration server re-reads `getBoardAccess` for every update it receives, so
a student who re-enables the button in devtools gets the note dropped like any
other forced write.

One thing has no public API: entering text editing immediately. Nothing on
`ExcalidrawImperativeAPI` opens the editor, so after inserting the note we
synthesise the `Enter` keydown Excalidraw's own handler already listens for, on
the next frame and only if the new note really is the sole selection. It is
best effort and wrapped so it can never throw: if it stops working after an
upgrade, the note is still inserted and still selected, and the user presses
Enter themselves. See the comment on `tryEnterTextEditing`.

### Export

The canvas exports to PNG and SVG through Excalidraw's own helpers, named after
the board. Excalidraw's fonts are copied into `public/excalidraw/` by
`npm run assets` (wired into `predev`/`prebuild`) instead of being fetched from
a CDN, so a classroom with a flaky network still renders correctly.

### Configuration

| Variable                   | Default              | What it does                        |
| -------------------------- | -------------------- | ----------------------------------- |
| `NEXT_PUBLIC_YJS_URL`      | `ws://localhost:1234`| Where the browser opens the socket  |
| `YJS_PORT` / `YJS_HOST`    | `1234` / `0.0.0.0`   | Where the server listens            |
| `YJS_SNAPSHOT_DEBOUNCE_MS` | `2000`               | Quiet time before a snapshot        |
| `YJS_SNAPSHOT_HISTORY`     | `20`                 | Snapshots kept per board            |
| `YJS_HEARTBEAT_MS`         | `20000`              | Participation heartbeat             |
| `YJS_STATUS_POLL_MS`       | `3000`               | How fast a status change is pushed  |
| `YJS_REAPER_MS`            | `60000`              | How often stale sessions are swept  |
| `YJS_STALE_AFTER_SECONDS`  | `120`                | Silence before a session is closed  |
| `BOARD_FILE_MAX_BYTES`     | `5242880`            | Largest single image upload (5 MiB) |

`NEXT_PUBLIC_YJS_URL` is inlined into the client bundle at build time, so the
production compose file passes it as a build argument as well as an env var.

