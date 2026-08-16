/**
 * STICKY NOTES — the pure half.
 *
 * Excalidraw has no sticky-note tool: drawing a rectangle and then double
 * clicking to type is four gestures, and in a brainstorm where 25 students
 * write 20 notes each that friction is what decides whether the exercise
 * works. This module holds everything about a sticky note that is a decision
 * rather than a side effect — where it goes, what it is made of, which
 * elements a colour click repaints, and whether a keystroke is ours to act on.
 *
 * Nothing here imports Excalidraw at runtime (the type imports are erased), so
 * it is testable in plain Node. The two calls that must happen in the browser —
 * `convertToExcalidrawElements` and `viewportCoordsToSceneCoords` — stay in the
 * component, which feeds their inputs and outputs through these functions.
 */

import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";

/**
 * Square, and the same for everyone. A fixed size is what makes a wall of
 * notes readable; the user can still resize one natively afterwards, because a
 * rectangle with bound text already reflows its text on resize.
 */
export const STICKY_NOTE_SIZE = 180;

/** Bound-text size, fixed so a board written by 25 people stays uniform. */
export const STICKY_NOTE_FONT_SIZE = 20;

/**
 * Ink for the bound text, and it MUST be set explicitly.
 *
 * Excalidraw builds a label's text element with
 * `strokeColor: label.strokeColor || container.strokeColor`, and a text
 * element's `strokeColor` is the colour of the letters. The note's container is
 * deliberately `transparent` so the square has no outline, so a label without
 * its own colour inherits that and the text is invisible — present, editable,
 * selectable, and impossible to see.
 *
 * `--ink` from the Academy Minimal palette, which clears 4.5:1 on every colour
 * in `STICKY_NOTE_COLORS`; they are all light pastels for exactly this reason.
 */
export const STICKY_NOTE_TEXT_COLOR = "#12141f";

/**
 * A sticky note is a rectangle, and so is a rectangle. `customData` is how we
 * tell them apart: it is part of the element, so it travels through the Yjs
 * document and every peer agrees on what is a note without any extra state.
 */
export const STICKY_NOTE_MARK = "sticky-note";

/**
 * The palette. Muted rather than saturated: 500 of these on one board at once
 * is the normal case, and fluorescent yellow at that density is unreadable.
 * `label` is the accessible name of the swatch button.
 */
export const STICKY_NOTE_COLORS = [
  { value: "#fef3c7", label: "Yellow" },
  { value: "#dcfce7", label: "Green" },
  { value: "#dbeafe", label: "Blue" },
  { value: "#fce7f3", label: "Pink" },
  { value: "#ede9fe", label: "Purple" },
  { value: "#fed7aa", label: "Orange" },
] as const;

export type StickyNoteColor = (typeof STICKY_NOTE_COLORS)[number]["value"];

export const DEFAULT_STICKY_NOTE_COLOR: StickyNoteColor =
  STICKY_NOTE_COLORS[0].value;

export const STICKY_NOTE_COLOR_STORAGE_KEY = "mural.stickyColor";

/** Narrows a value read back out of localStorage, which is `string | null`. */
export function isStickyNoteColor(value: unknown): value is StickyNoteColor {
  return STICKY_NOTE_COLORS.some((entry) => entry.value === value);
}

/** What the stored preference resolves to, including "nothing stored yet". */
export function readStickyNoteColor(stored: string | null): StickyNoteColor {
  return isStickyNoteColor(stored) ? stored : DEFAULT_STICKY_NOTE_COLOR;
}

/**
 * The subset of Excalidraw's app state this module needs. Declared structurally
 * rather than imported so the tests can build one by hand, and so a field being
 * renamed upstream shows up here as a type error rather than at runtime.
 */
export interface StickyViewport {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
}

/**
 * The centre of what the user is currently looking at, in *viewport* pixels.
 *
 * The scene origin is not it: a class that has scrolled away from it would get
 * a note dropped somewhere off screen, and a student would swear the button is
 * broken. The caller converts this to scene coordinates with Excalidraw's own
 * `viewportCoordsToSceneCoords`, which is the only party that knows the current
 * zoom and scroll.
 */
export function viewportCentre(viewport: StickyViewport): {
  clientX: number;
  clientY: number;
} {
  return {
    clientX: viewport.offsetLeft + viewport.width / 2,
    clientY: viewport.offsetTop + viewport.height / 2,
  };
}

/**
 * Excalidraw positions an element by its top-left corner, so the scene point we
 * want the note centred on has to be moved half a note up and left.
 */
export function stickyNoteOrigin(centre: { x: number; y: number }): {
  x: number;
  y: number;
} {
  return {
    x: Math.round(centre.x - STICKY_NOTE_SIZE / 2),
    y: Math.round(centre.y - STICKY_NOTE_SIZE / 2),
  };
}

/**
 * The skeleton handed to `convertToExcalidrawElements`.
 *
 * It is deliberately NOT a finished element. Excalidraw generates `version`,
 * `versionNonce` and `seed` itself, and those three are exactly what the
 * reconciliation in `board-canvas-scene.tsx` uses to decide whose copy of an
 * element wins. Hand-building an element means inventing them, and inventing
 * them is how two students editing the same note stop converging.
 *
 * `label.text` is a single space rather than the empty string on purpose:
 * `convertToExcalidrawElements` only creates the bound text container when the
 * label has truthy text, and the bound text is what fixes the font size and the
 * centring for everyone. Excalidraw selects the existing text when editing
 * starts, so the first character typed replaces the space; and if the note is
 * never typed into, Excalidraw unbinds a whitespace-only text on submit.
 */
export function stickyNoteSkeleton(
  color: StickyNoteColor,
  origin: { x: number; y: number },
  id: string,
): ExcalidrawElementSkeleton {
  return {
    type: "rectangle",
    id,
    x: origin.x,
    y: origin.y,
    width: STICKY_NOTE_SIZE,
    height: STICKY_NOTE_SIZE,
    backgroundColor: color,
    // A sticky note is a filled square of paper; hachure would read as a shape.
    fillStyle: "solid",
    strokeColor: "transparent",
    strokeWidth: 1,
    strokeStyle: "solid",
    // Excalidraw's own "sketchy" roughness on a note that exists to be read is
    // noise, and 500 rough rectangles are measurably slower to render.
    roughness: 0,
    // ROUNDNESS.ADAPTIVE_RADIUS — the fixed-pixel radius rectangles use.
    roundness: { type: 3 },
    customData: { [STICKY_NOTE_MARK]: true },
    label: {
      text: " ",
      fontSize: STICKY_NOTE_FONT_SIZE,
      textAlign: "center",
      verticalAlign: "middle",
      // Without this the text inherits the container's transparent stroke and
      // becomes invisible. See STICKY_NOTE_TEXT_COLOR.
      strokeColor: STICKY_NOTE_TEXT_COLOR,
    },
  };
}

/** Whether this element is one of ours, as opposed to a drawn rectangle. */
export function isStickyNote(element: {
  type: string;
  customData?: Record<string, unknown> | null;
}): boolean {
  return (
    element.type === "rectangle" && element.customData?.[STICKY_NOTE_MARK] === true
  );
}

/**
 * THE COLOUR RULE.
 *
 * Clicking a swatch always sets the colour of the *next* note. On top of that,
 * it repaints the sticky notes that are selected right now — and only those.
 * A selected rectangle someone drew by hand is left alone: the swatch row is
 * the sticky-note tool, not a general fill picker, and silently recolouring
 * somebody's diagram would be worse than doing nothing.
 *
 * Returns `null` when nothing would change, so the caller can skip the
 * `updateScene` entirely rather than broadcasting a no-op edit to the class.
 *
 * `version` is bumped and `versionNonce` refreshed exactly as every other edit
 * path in this app does, because that is what makes the change flush and what
 * lets reconciliation order it against a peer's edit to the same note.
 */
export interface StickyRecolourable {
  id: string;
  type: string;
  isDeleted?: boolean;
  version: number;
  backgroundColor: string;
  customData?: Record<string, unknown> | null;
}

export function recolourSelectedStickyNotes<T extends StickyRecolourable>(
  elements: readonly T[],
  selectedElementIds: Readonly<Record<string, boolean>>,
  color: StickyNoteColor,
  nextVersionNonce: () => number,
): T[] | null {
  let changed = false;

  const next = elements.map((element) => {
    if (element.isDeleted) return element;
    if (!selectedElementIds[element.id]) return element;
    if (!isStickyNote(element)) return element;
    if (element.backgroundColor === color) return element;

    changed = true;
    return {
      ...element,
      backgroundColor: color,
      version: element.version + 1,
      versionNonce: nextVersionNonce(),
    };
  });

  return changed ? next : null;
}

/**
 * The subset of a `KeyboardEvent` the shortcut guard reads. Structural so the
 * tests can pass a literal instead of constructing a DOM event.
 */
export interface StickyKeyEvent {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** Held down. A repeat must not machine-gun notes onto the board. */
  repeat?: boolean;
  /**
   * `unknown` rather than `EventTarget`: this is read structurally for a tag
   * name and `isContentEditable`, neither of which is on `EventTarget`, and
   * typing it loosely is what lets the tests hand it a literal instead of
   * building a DOM.
   */
  target: unknown;
}

/** The live editing state, read from `getAppState()` at the moment of the key. */
export interface StickyEditingState {
  /** A bound or standalone text element is being typed into right now. */
  editingTextElement: unknown;
  /** A frame's name is being renamed. */
  editingFrame: unknown;
  /** A line or arrow has its points open for editing. */
  editingLinearElement: unknown;
  /** A modal (export, help, …) owns the keyboard. */
  openDialog: unknown;
}

/**
 * `Shift`+`N`.
 *
 * Excalidraw's tools own the bare digits `0`-`9` and the letters
 * `v r d o a l p x t e h f`, and its other bindings are all behind
 * Ctrl/Cmd or Alt. `n` appears nowhere in its key table at all — not as a tool,
 * not as an action — so neither `n` nor `Shift`+`N` collides today. Requiring
 * Shift is the cheap insurance: the bare single-letter namespace is exactly
 * where Excalidraw adds new tools, and a bare letter is also one slip away from
 * a note appearing every time somebody means to type.
 */
export const STICKY_NOTE_SHORTCUT_LABEL = "Shift+N";

function isTextEntryTarget(target: unknown): boolean {
  if (target === null || typeof target !== "object") return false;
  const node = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
  };
  const tagName = typeof node.tagName === "string" ? node.tagName : "";
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  return node.isContentEditable === true;
}

/**
 * THE GUARD. Whether this keystroke should create a note.
 *
 * The "is the user typing" half is not optional politeness: Excalidraw's text
 * editor is a real `<textarea>` overlaid on the canvas, so without this a
 * student writing "Anna" into a note would get a new note for the `n`. It is
 * checked twice over — once on the event target, which catches every input in
 * the page including our own chrome, and once on Excalidraw's app state, which
 * catches the editing modes that do not focus an input.
 *
 * `canWrite` is the live authority the collaboration server last pushed. It is
 * a reflection, never the decision: the websocket server re-reads
 * `getBoardAccess` for every update it receives and drops this write on a
 * frozen board whatever this function returns.
 */
export function shouldCreateStickyNote(
  event: StickyKeyEvent,
  context: { canWrite: boolean; editing: StickyEditingState | null },
): boolean {
  if (!context.canWrite) return false;
  if (event.repeat) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (!event.shiftKey) return false;
  if (event.key.toLowerCase() !== "n") return false;
  if (isTextEntryTarget(event.target)) return false;

  const editing = context.editing;
  if (editing === null) return false;
  if (editing.editingTextElement !== null) return false;
  if (editing.editingFrame !== null) return false;
  if (editing.editingLinearElement !== null) return false;
  if (editing.openDialog !== null) return false;

  return true;
}
