import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSessionToken } from "@/lib/auth/session";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session-cookie";
import { boardSessions } from "@/lib/db/schema";
import {
  CLOSE_NOT_FOUND,
  CLOSE_UNAUTHENTICATED,
} from "@/yjs-server/close-codes";
import type { YjsServer } from "@/yjs-server/server";
import { resetDatabase, testDb } from "../setup/db";
import { seedBoardWithMember } from "../setup/fixtures";
import { cookieFor, rawConnect, startTestServer, waitUntil } from "../setup/yjs";

let server: YjsServer;

beforeEach(async () => {
  await resetDatabase();
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

describe("websocket handshake authentication", () => {
  it("rejects a connection that sends no cookie at all", async () => {
    const { board } = await seedBoardWithMember();

    const { closed } = rawConnect(server, `/${board.id}`, null);

    expect((await closed).code).toBe(CLOSE_UNAUTHENTICATED);
  });

  it("rejects a forged session token", async () => {
    const { board } = await seedBoardWithMember();
    const forged = `${SESSION_COOKIE_NAME}=${generateSessionToken()}`;

    const { closed } = rawConnect(server, `/${board.id}`, forged);

    expect((await closed).code).toBe(CLOSE_UNAUTHENTICATED);
  });

  it("rejects a cookie header that carries other cookies but no session", async () => {
    const { board } = await seedBoardWithMember();

    const { closed } = rawConnect(server, `/${board.id}`, "theme=dark; lang=es");

    expect((await closed).code).toBe(CLOSE_UNAUTHENTICATED);
  });

  it("accepts a member with a valid session and starts syncing", async () => {
    const { student, board } = await seedBoardWithMember();

    const { socket, firstMessage } = rawConnect(
      server,
      `/${board.id}`,
      await cookieFor(student.id),
    );

    // The server speaks first with sync step 1; receiving it proves the
    // handshake was accepted and the room was joined.
    const message = await firstMessage;
    expect(message.length).toBeGreaterThan(0);
    expect(message[0]).toBe(0); // messageSync
    socket.close();
  });

  it("accepts the teacher on a board they own", async () => {
    const { teacher, board } = await seedBoardWithMember();

    const { socket, firstMessage } = rawConnect(
      server,
      `/${board.id}`,
      await cookieFor(teacher.id),
    );

    expect((await firstMessage)[0]).toBe(0);
    socket.close();
  });

  it("opens exactly one board_session row per accepted connection", async () => {
    const { student, board } = await seedBoardWithMember();
    const cookie = await cookieFor(student.id);

    const first = rawConnect(server, `/${board.id}`, cookie);
    await first.firstMessage;
    const second = rawConnect(server, `/${board.id}`, cookie);
    await second.firstMessage;

    await waitUntil(
      async () =>
        (await testDb
          .select()
          .from(boardSessions)
          .where(eq(boardSessions.boardId, board.id))) .length === 2,
      { label: "two board_session rows" },
    );

    const rows = await testDb
      .select()
      .from(boardSessions)
      .where(eq(boardSessions.boardId, board.id));
    // Two tabs of the same student stay distinguishable.
    expect(new Set(rows.map((row) => row.connectionId)).size).toBe(2);

    first.socket.close();
    second.socket.close();
  });
});

describe("board existence is not probeable", () => {
  it("closes a non-member with the same code as a board that does not exist", async () => {
    const { outsider, board } = await seedBoardWithMember();
    const cookie = await cookieFor(outsider.id);
    const missingBoardId = "00000000-0000-4000-8000-000000000000";

    const nonMember = rawConnect(server, `/${board.id}`, cookie);
    const missing = rawConnect(server, `/${missingBoardId}`, cookie);

    const nonMemberClose = await nonMember.closed;
    const missingClose = await missing.closed;

    expect(nonMemberClose.code).toBe(CLOSE_NOT_FOUND);
    expect(missingClose.code).toBe(CLOSE_NOT_FOUND);
    // Identical reason strings: nothing distinguishes "you may not" from
    // "it is not there", exactly like the Phase A notFound() page.
    expect(nonMemberClose.reason).toBe(missingClose.reason);
  });

  it("rejects a malformed board id the same way", async () => {
    const { student } = await seedBoardWithMember();

    const { closed } = rawConnect(
      server,
      "/not-a-uuid",
      await cookieFor(student.id),
    );

    expect((await closed).code).toBe(CLOSE_NOT_FOUND);
  });

  it("rejects a connection with no board id in the path", async () => {
    const { student } = await seedBoardWithMember();

    const { closed } = rawConnect(server, "/", await cookieFor(student.id));

    expect((await closed).code).toBe(CLOSE_NOT_FOUND);
  });

  it("never opens a participation row for a rejected connection", async () => {
    const { outsider, board } = await seedBoardWithMember();

    const { closed } = rawConnect(
      server,
      `/${board.id}`,
      await cookieFor(outsider.id),
    );
    await closed;

    const rows = await testDb.select().from(boardSessions);
    expect(rows).toHaveLength(0);
  });
});

describe("path shapes", () => {
  it("accepts the /yjs prefix that Caddy proxies in production", async () => {
    const { student, board } = await seedBoardWithMember();

    const { socket, firstMessage } = rawConnect(
      server,
      `/yjs/${board.id}`,
      await cookieFor(student.id),
    );

    expect((await firstMessage)[0]).toBe(0);
    socket.close();
  });
});
