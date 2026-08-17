/**
 * Re-exports the shared element builders. They used to live here, hand-built
 * for this skill only; they moved to `lib/collab/elements.ts` so the browser
 * icon tool (`components/board-chrome.tsx`) and this skill's `image` shape
 * could share the exact same builder instead of drifting apart. See that
 * module for the full rationale.
 */
export {
  arrow,
  assertWellFormed,
  badge,
  box,
  image,
  rectangle,
  text,
  type Box,
  type Point,
  type TextOptions,
} from "@/lib/collab/elements";
