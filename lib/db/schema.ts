import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Postgres `bytea` mapped to a Node Buffer. Used for Yjs binary snapshots. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Roles are coarse on purpose: a teacher administers boards, a student uses
 * them. Role always comes from the database row, never from the client.
 */
export const userRole = pgEnum("user_role", ["teacher", "student"]);

/**
 * Board status is the server-side authority over who may write to a board.
 *   active   - members may read and write
 *   frozen   - nobody may write, not even the owner (used to freeze an exercise)
 *   readonly - members may read; only the owner/teacher may write
 * The Phase B websocket server reads this value to accept or reject Yjs updates.
 */
export const boardStatus = pgEnum("board_status", [
  "active",
  "frozen",
  "readonly",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    role: userRole("role").notNull().default("student"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Emails are stored already normalized (trimmed + lowercased) by the
    // application layer, so a plain unique index is enough.
    uniqueIndex("users_email_unique").on(table.email),
    index("users_role_idx").on(table.role),
  ],
);

export const boards = pgTable(
  "boards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      // Deleting a teacher must not silently orphan or destroy class material,
      // so the delete is restricted; boards must be reassigned or removed first.
      .references(() => users.id, { onDelete: "restrict" }),
    status: boardStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("boards_owner_idx").on(table.ownerId),
    index("boards_status_idx").on(table.status),
  ],
);

export const boardMembers = pgTable(
  "board_members",
  {
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.boardId, table.userId] }),
    // Drives the "my boards" query for a student.
    index("board_members_user_idx").on(table.userId),
  ],
);

/**
 * PARTICIPATION / ATTRIBUTION LOG.
 *
 * One row per websocket connection to a board. Phase B opens a row on connect,
 * heartbeats `last_seen_at`, closes it on disconnect and increments
 * `edit_count` as the user mutates the document.
 *
 * This shape answers "which boards did student X participate in, and how much"
 * without any later schema change:
 *   - presence time  = sum(coalesce(disconnected_at, last_seen_at) - connected_at)
 *   - contribution   = sum(edit_count)
 *   - engagement     = count(*) distinct sessions, first/last seen
 * `last_seen_at` is what makes the duration honest when a connection dies
 * without a clean disconnect: an abandoned tab stops accruing time at its last
 * heartbeat instead of accruing it forever.
 * `connectionId` lets Phase B reconcile a row it already opened (multiple tabs
 * of the same user are separate connections and therefore separate rows).
 */
export const boardSessions = pgTable(
  "board_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Opaque per-connection identifier supplied by the websocket server. */
    connectionId: text("connection_id"),
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    /** Heartbeat. Also the upper bound of a session that never closed cleanly. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Number of document mutations attributed to this connection. */
    editCount: integer("edit_count").notNull().default(0),
  },
  (table) => [
    // "How much did user X participate, everywhere" and the per-board variant.
    index("board_sessions_user_board_idx").on(table.userId, table.boardId),
    // "Who was on board Y, and when" (roster/timeline per board).
    index("board_sessions_board_connected_idx").on(
      table.boardId,
      table.connectedAt,
    ),
    // Cheap lookup of still-open sessions for the stale-session reaper.
    index("board_sessions_open_idx")
      .on(table.boardId, table.userId)
      .where(sql`disconnected_at is null`),
  ],
);

/**
 * Yjs document snapshots. Phase B serialises the CRDT state
 * (`Y.encodeStateAsUpdate(doc)`) and appends a row; the newest row per board is
 * the one to load. Append-only so a corrupted board can be rolled back.
 */
export const boardSnapshots = pgTable(
  "board_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    yjsState: bytea("yjs_state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Latest-snapshot-per-board lookup.
    index("board_snapshots_board_created_idx").on(
      table.boardId,
      table.createdAt,
    ),
  ],
);

/**
 * Authentication session store. `id` is the SHA-256 hash of the token held in
 * the cookie, so a database leak does not hand out usable sessions.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("sessions_user_idx").on(table.userId),
    index("sessions_expires_idx").on(table.expiresAt),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Board = typeof boards.$inferSelect;
export type NewBoard = typeof boards.$inferInsert;
export type BoardMember = typeof boardMembers.$inferSelect;
export type BoardSession = typeof boardSessions.$inferSelect;
export type BoardSnapshot = typeof boardSnapshots.$inferSelect;
export type AuthSession = typeof sessions.$inferSelect;
export type UserRole = (typeof userRole.enumValues)[number];
export type BoardStatus = (typeof boardStatus.enumValues)[number];
