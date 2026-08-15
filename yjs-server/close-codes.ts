/**
 * Websocket close codes used by the collaboration server.
 *
 * The 4400-4499 range is treated as permanent by the y-websocket client: it
 * stops reconnecting instead of hammering the server. Everything outside that
 * range (a restart, for instance) lets the client back off and retry.
 */

/** No usable `mural_session` cookie, or the session is expired/forged. */
export const CLOSE_UNAUTHENTICATED = 4401;

/**
 * The board does not exist, OR the user may not view it. Deliberately the same
 * code and the same reason for both, so board existence cannot be probed -
 * this mirrors the `notFound()` that Phase A returns for an unauthorised board.
 */
export const CLOSE_NOT_FOUND = 4404;

/** The server failed while setting the connection up. Retrying is reasonable. */
export const CLOSE_SERVER_ERROR = 1011;

/** The server is shutting down. Clients should reconnect. */
export const CLOSE_GOING_AWAY = 1001;

export const REASON_UNAUTHENTICATED = "unauthenticated";

/** One string for both "no such board" and "not your board". */
export const REASON_NOT_FOUND = "board not found";

export const REASON_SHUTDOWN = "server shutting down";
