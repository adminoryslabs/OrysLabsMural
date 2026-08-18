---
name: prepare-board
description: Draw or edit content on an OrysLabsMural (OrysLabs Collab) board — building class material from a reference image or a description. Trigger on requests to draw, sketch, lay out, or build a board/diagram/infographic for a class.
---

# Prepare a board

Draws directly onto a live OrysLabsMural board over the real collaboration
protocol — the same one a browser tab uses. There is no partial-element mode:
every request ("draw this reference", "lay out a diagram of X") is answered by
composing a full scene and writing it in one batch. Do not ask the user to
break a board request into individual shapes; that judgment belongs to you.

## Setup (once per person running this)

1. Someone with database access runs, once:
   ```
   npx tsx scripts/mint-agent-token.ts
   ```
   from the project root. It prints `MURAL_AGENT_SESSION_TOKEN` and
   `MURAL_AGENT_YJS_URL`.
2. Everyone who uses this skill sets those two as local environment variables
   (shell profile, or a local untracked `.env`). Never commit them — the token
   is a standing credential, shared the same way any other project access is,
   and good for as long as it keeps getting used (see "Why a session token"
   below).
3. If a scene places any `image` shape (see the icon bank below), also set
   `MURAL_AGENT_APP_URL` — the app's plain HTTP origin (e.g.
   `http://localhost:3000` locally), distinct from `MURAL_AGENT_YJS_URL`. Not
   needed for scenes with no icons.

If either variable is missing, `read-board.ts`/`write-board.ts` fail with a
clear message pointing back here — that is the signal setup did not happen.

**Do not read or `cat` the `.env` file, and do not ask the user to paste its
values.** Both scripts already start with `import "dotenv/config"`, which
loads the project's `.env` into `process.env` before anything else runs — the
same way any local `.env` var reaches any other script in this repo. Just run
the scripts; if the file exists with the right keys, the vars are there
already. Only ask the user for the values if a script actually fails with the
missing-variable message.

## Workflow

1. **Get the board id.** The user gives you a board URL
   (`/boards/<id>`) or just asks you to work on "the board I have open" — ask
   for the URL if you don't have it, do not guess an id.
2. **Read before you write, if the board is not empty.** Run:
   ```
   npx tsx .claude/skills/prepare-board/scripts/read-board.ts --board <id>
   ```
   This dumps the current elements as JSON (position, size, colors, text,
   grouping). Use it to avoid overlapping existing content and to match the
   board's visual language when adding to it.
3. **Compose the scene.** Write a JSON array of `Shape`s (schema below) to a
   file, describing the whole layout — not one shape at a time.
4. **Write it.** Run:
   ```
   npx tsx .claude/skills/prepare-board/scripts/write-board.ts --board <id> --file <scene.json>
   ```
   If it prints "The server refused this write", the board is frozen or you
   lack access — this is the same authority check every real client goes
   through, there is no bypass to reach for.
5. Tell the user the board URL so they can look at it. **You cannot see the
   render yourself** — there is no browser in this environment. Say so; do not
   claim it looks right.

## Shape schema

```ts
type Shape =
  | { type: "box"; x; y; w; h; title: string; body?: string;
      fill?: string; stroke?: string; strokeWidth?: number;
      titleSize?: number; bodySize?: number; textColor?: string }
  | { type: "badge"; x; y; w; h; label: string; fill?: string; stroke?: string; fontSize?: number }
  | { type: "rectangle"; x; y; w; h; fill?: string; stroke?: string; strokeWidth?: number }
  | { type: "text"; x; y; text: string; fontSize?: number; color?: string; width?: number; align?: "left"|"center"|"right" }
  | { type: "arrow"; from: {x,y}; to: {x,y}; color?: string; strokeWidth?: number }
  | { type: "image"; x; y; w; h; fileId: string }
```

Use **`box`** for anything with a title (and optionally a body): it groups the
rectangle and its text so dragging one moves all of it, and auto-sizes the
height to the text. This is the workhorse — most of a layout is `box`
entries.

Use **`badge`** only for a short single-line label (a session number, a small
tag): it uses real Excalidraw bound-text instead of grouping, which is the
correct tool for exactly one line but cannot hold a title + body.

Use bare **`rectangle`**/**`text`** only when you deliberately want an
unlabelled shape or free-floating text not tied to a box.

Coordinates are canvas pixels, x/y is the top-left corner. There is no
auto-layout: you decide positions. A reasonable working canvas is roughly
1600×900; leave ~20-30px gaps between boxes so borders don't touch.

## Visual conventions (validated against a real reference, twice)

- Leave `strokeWidth`/`fill`/`stroke` at their defaults unless the reference
  calls for emphasis — the defaults already read as a clean sketch.
- Every shape defaults to `roughness: 1` (rough.js's hand-drawn stroke,
  rendered client-side) — this is what makes it look sketched rather than
  vector-perfect, matching Excalidraw's own native look. Do not set it to 0
  unless a specific shape should look intentionally "clean" against the rest.
- Pick 3-5 stroke colors max per board and reuse them for related groups
  (e.g. all "risk" boxes in red, all "flow" boxes in purple) — a reference
  infographic's color-coding is usually meaningful, keep it.
- Icons: unicode/emoji glyphs (⚠ ✓ ☆ ⚖ ①-⑩ etc.) still work fine inline in a
  `text` or as the first character of a `box` title, for anything not covered
  below.
- **The doodle icon bank.** A growing set of hand-drawn images, matching the
  sketchy `roughness: 1` look of the shapes around them (a clean vector icon
  would look pasted-on next to them). It is the app's global catalog — a
  teacher can add to it from `/teacher/icons` at any time, with no deploy —
  so it is not a fixed list this file can print a table of; fetch the current
  one before assuming a name exists:
  ```
  curl -s -H "Cookie: mural_session=$MURAL_AGENT_SESSION_TOKEN" \
    "$MURAL_AGENT_APP_URL/api/icons"
  ```
  Place one with an `image` shape using the `fileId` from that response —
  `write-board.ts` uploads the bytes to the board automatically the first
  time it is used there, fetching them from the catalog over HTTP using
  `MURAL_AGENT_APP_URL` (see Setup above).

  Do not invent a `fileId` — an id the catalog does not list was never
  uploaded and the element will render as a broken picture frame for the
  whole class. If a request needs a glyph the catalog does not have, tell the
  user rather than approximating with an emoji shape and calling it the same
  thing.

## Why a session token, not a login step

The write/read scripts take a pre-minted session token, not credentials,
because the collaboration server's auth is a cookie — there is no simple HTTP
login endpoint to script against (the app's login is a Next.js Server Action).
The token is an ordinary session (`lib/auth/session.ts`): it renews itself
whenever it's used within 15 days of expiring, so in practice it never expires
while the skill is in regular use — but it is NOT a permanent credential, and
it dies like any idle session if unused for 30 days straight. Treat a leak the
same as any other credential leak: re-run `mint-agent-token.ts` to invalidate
it and mint a fresh one.

## What this does NOT do

- No board creation, membership, freeze/unfreeze, or deletion — those are
  teacher actions in the app itself, on purpose. This skill only draws.
- No arbitrary image upload. `write-board.ts` uploads bytes only for icons
  that already exist in the app's global catalog (`/api/icons`); an `image`
  shape with any other `fileId` still requires that file to already exist as
  a `board_files` row.
- Authority is never bypassed. A frozen board rejects this exactly like it
  rejects a student — the websocket server re-checks `getBoardAccess` on every
  write, unconditionally.
