import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { BoardStatus } from "@/lib/db/schema";

/**
 * THE BOARD STATUS FRAME.
 *
 * A server-initiated message that tells one connection what the board's status
 * is and whether that connection may currently write to it.
 *
 * It exists because the per-write authority check cannot see an unfreeze: a
 * client that has been refused stops sending write frames, so there is nothing
 * left for the server to answer. The status has to be pushed.
 *
 * IT IS A HINT, NEVER THE ENFORCEMENT. The websocket server re-reads
 * `getBoardAccess` for every update it receives, so a client that ignores this
 * frame, or fabricates one, gains exactly nothing. The frame is only ever
 * accepted in the server-to-client direction; the server classifies an incoming
 * frame of this type as "ignored", like any other unknown message.
 */
export const MESSAGE_BOARD_STATUS = 100;

/**
 * The board statuses, spelled out here so the browser bundle does not have to
 * import the Drizzle schema at runtime. `satisfies` keeps it honest: adding a
 * status to the database enum without adding it here fails to compile.
 */
const BOARD_STATUSES = ["active", "frozen", "readonly"] as const satisfies
  readonly BoardStatus[];

export interface BoardAuthorityState {
  status: BoardStatus;
  /** What the server would answer right now for THIS connection. */
  canWrite: boolean;
}

function isBoardStatus(value: string): value is BoardStatus {
  return (BOARD_STATUSES as readonly string[]).includes(value);
}

export function encodeBoardStatus(state: BoardAuthorityState): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_BOARD_STATUS);
  encoding.writeVarString(encoder, state.status);
  encoding.writeVarUint(encoder, state.canWrite ? 1 : 0);
  return encoding.toUint8Array(encoder);
}

/**
 * Reads the payload of a status frame from a decoder whose message type has
 * already been consumed - which is how the y-websocket provider hands a frame
 * to a message handler. Returns null for anything malformed or unknown, so a
 * hostile or newer peer can never make the client throw.
 */
export function decodeBoardStatusPayload(
  decoder: decoding.Decoder,
): BoardAuthorityState | null {
  try {
    const status = decoding.readVarString(decoder);
    if (!isBoardStatus(status)) return null;
    return { status, canWrite: decoding.readVarUint(decoder) === 1 };
  } catch {
    return null;
  }
}

/** Same, from a whole frame. Used by tests and by non-provider clients. */
export function decodeBoardStatus(
  data: Uint8Array,
): BoardAuthorityState | null {
  try {
    const decoder = decoding.createDecoder(data);
    if (decoding.readVarUint(decoder) !== MESSAGE_BOARD_STATUS) return null;
    return decodeBoardStatusPayload(decoder);
  } catch {
    return null;
  }
}
