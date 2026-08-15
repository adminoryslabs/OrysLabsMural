/**
 * The presence palette. One colour per user, stable for as long as their id is,
 * so the same student is the same colour on the dashboard, in the roster and on
 * their cursor. Lives apart from `board-session.ts` because server components
 * need it and must not pull the websocket client into their bundle.
 */
const PEER_COLORS = [
  "#e11d48",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0891b2",
  "#2563eb",
  "#7c3aed",
  "#db2777",
] as const;

/** Deterministic, readable cursor colour derived from the user id. */
export function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return PEER_COLORS[hash % PEER_COLORS.length] ?? "#2563eb";
}

/**
 * The one or two letters shown in an avatar. Takes the first letter of the
 * first and last words, so "Ada Lovelace" is AL and "Ada" is A.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}
