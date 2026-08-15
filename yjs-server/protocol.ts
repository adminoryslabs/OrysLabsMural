import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as authProtocol from "y-protocols/auth";
import type { Awareness } from "y-protocols/awareness";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";

/**
 * The y-websocket wire protocol, spelled out.
 *
 * Every frame starts with a varuint message type. The server has to decode it
 * itself instead of handing the buffer to `syncProtocol.readSyncMessage`,
 * because that helper applies the update immediately - and applying before the
 * authority check is exactly the bug this whole layer exists to prevent.
 */
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_AUTH = 2;
export const MESSAGE_QUERY_AWARENESS = 3;

export const SYNC_STEP_1 = syncProtocol.messageYjsSyncStep1;
export const SYNC_STEP_2 = syncProtocol.messageYjsSyncStep2;
export const SYNC_UPDATE = syncProtocol.messageYjsUpdate;

/** "Tell me what you have": the state vector exchange that opens a session. */
export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/** The answer to a peer's step 1: everything it is missing. */
export function encodeSyncStep2(
  doc: Y.Doc,
  stateVector: Uint8Array,
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep2(encoder, doc, stateVector);
  return encoding.toUint8Array(encoder);
}

/** An incremental document update, relayed to the other clients. */
export function encodeUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** Presence: cursors and display names. */
export function encodeAwareness(
  awareness: Awareness,
  clients: number[],
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, clients),
  );
  return encoding.toUint8Array(encoder);
}

/**
 * "Your write was refused." The client uses this to stop pretending it is
 * editing and to resynchronise with the authoritative document.
 */
export function encodePermissionDenied(reason: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AUTH);
  authProtocol.writePermissionDenied(encoder, reason);
  return encoding.toUint8Array(encoder);
}

export type IncomingMessage =
  | { kind: "sync-step-1"; stateVector: Uint8Array }
  | { kind: "sync-update"; update: Uint8Array }
  | { kind: "awareness"; update: Uint8Array }
  | { kind: "query-awareness" }
  | { kind: "ignored" };

/**
 * Classifies a frame without mutating any document. `sync-update` covers both
 * sync step 2 and a plain update: both carry writes and both must pass the
 * authority check before they touch the shared document.
 */
export function decodeMessage(data: Uint8Array): IncomingMessage {
  try {
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MESSAGE_SYNC: {
        const syncType = decoding.readVarUint(decoder);
        if (syncType === SYNC_STEP_1) {
          return {
            kind: "sync-step-1",
            stateVector: decoding.readVarUint8Array(decoder),
          };
        }
        if (syncType === SYNC_STEP_2 || syncType === SYNC_UPDATE) {
          return {
            kind: "sync-update",
            update: decoding.readVarUint8Array(decoder),
          };
        }
        return { kind: "ignored" };
      }
      case MESSAGE_AWARENESS:
        return {
          kind: "awareness",
          update: decoding.readVarUint8Array(decoder),
        };
      case MESSAGE_QUERY_AWARENESS:
        return { kind: "query-awareness" };
      default:
        return { kind: "ignored" };
    }
  } catch {
    // A truncated or hostile frame is dropped, never fatal.
    return { kind: "ignored" };
  }
}

/**
 * True when the update carries no operations. An empty update is what a fresh
 * client sends as sync step 2, and counting it as an edit would inflate the
 * participation numbers for someone who only opened the board.
 */
export function isEmptyUpdate(update: Uint8Array): boolean {
  // Two structural zeros: no structs, no delete-set entries.
  return update.length <= 2;
}
