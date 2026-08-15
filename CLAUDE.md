# OrysLabsMural — project instructions

Self-hosted collaborative whiteboard used to teach live classes. ~25 concurrent students.

## Testing policy

Strict TDD — writing a failing test before every implementation — is **disabled**, here and
globally. The red-green ceremony costs two passes over the same code and does not pay for
itself on UI and glue, especially since no browser can run in this environment.

Tests are still **mandatory** where they carry weight. Write them for:

- **`lib/boards/authority.ts` and anything enforcing it.** This is the security boundary:
  who may write to a board, and what `frozen` / `readonly` / `active` mean. Students in this
  class can open devtools. A regression here is not a bug, it is a hole.
- **Websocket authentication and rejection paths**, including the property that a
  non-member and a missing board are indistinguishable from the outside.
- **Participation and attribution queries** backing `board_sessions`. These numbers are
  reported to students; silent drift makes them lie.
- **Persistence round-trips** for `board_snapshots`, including rehydration after a restart.

Tests are optional for presentational components, styling, and mechanical wiring.

Tests run against a real PostgreSQL instance in Docker. **Never mock the database layer.**

## Non-negotiable architecture

1. **Authority lives on the server.** Board status pushed to a client is a UI hint, never
   enforcement. The websocket server re-reads `getBoardAccess` and rejects writes on its own.
   A client that forges or ignores that hint must gain nothing. Never trust a client-supplied
   role or status.
2. **Every edit is attributable to a `userId`.** The instructor must be able to answer which
   boards a student took part in, and how much. Do not add write paths that bypass this.

## Conventions

- All artifacts in English: code, identifiers, comments, UI copy, docs, commit messages.
  Conversation with the user happens in Spanish; artifacts do not.
- Conventional commits. Never add `Co-Authored-By` or any AI attribution.
- Writes to `.env` / `.env.example` paths are blocked in this environment. The template is
  `env.example`; copy it to `.env` manually.
