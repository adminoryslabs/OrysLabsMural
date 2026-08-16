import { describe, expect, it } from "vitest";
import {
  DEFAULT_STICKY_NOTE_COLOR,
  STICKY_NOTE_COLORS,
  STICKY_NOTE_MARK,
  STICKY_NOTE_SIZE,
  isStickyNote,
  isStickyNoteColor,
  readStickyNoteColor,
  recolourSelectedStickyNotes,
  shouldCreateStickyNote,
  stickyNoteOrigin,
  stickyNoteSkeleton,
  STICKY_NOTE_TEXT_COLOR,
  viewportCentre,
  type StickyEditingState,
  type StickyKeyEvent,
} from "@/lib/collab/sticky-note";

/**
 * The sticky-note tool's decisions. The two Excalidraw calls it is wrapped in —
 * `convertToExcalidrawElements` and `viewportCoordsToSceneCoords` — touch the
 * DOM at import time and are not covered here; what is covered is everything
 * that decides *what* to hand them and *whether* to act at all.
 */

const YELLOW = STICKY_NOTE_COLORS[0].value;
const GREEN = STICKY_NOTE_COLORS[1].value;

describe("where a new note goes", () => {
  it("aims at the centre of the visible canvas, not the scene origin", () => {
    // A canvas offset 300px from the left of the page (the session panel) and
    // 56px from the top (the board top bar).
    expect(
      viewportCentre({
        width: 800,
        height: 600,
        offsetLeft: 300,
        offsetTop: 56,
      }),
    ).toEqual({ clientX: 700, clientY: 356 });
  });

  it("offsets the top-left corner so the note is centred on that point", () => {
    // Excalidraw positions by the top-left corner; the caller has a centre.
    expect(stickyNoteOrigin({ x: 1000, y: -400 })).toEqual({
      x: 1000 - STICKY_NOTE_SIZE / 2,
      y: -400 - STICKY_NOTE_SIZE / 2,
    });
  });

  it("rounds, so a fractional zoom does not put a note on a half pixel", () => {
    expect(stickyNoteOrigin({ x: 10.4, y: 10.6 })).toEqual({
      x: -80,
      y: -79,
    });
  });
});

describe("the note skeleton", () => {
  const note = stickyNoteSkeleton(GREEN, { x: 12, y: 34 }, "note-1");

  it("is a square, solid, marked rectangle in the chosen colour", () => {
    expect(note).toMatchObject({
      type: "rectangle",
      id: "note-1",
      x: 12,
      y: 34,
      width: STICKY_NOTE_SIZE,
      height: STICKY_NOTE_SIZE,
      backgroundColor: GREEN,
      fillStyle: "solid",
      customData: { [STICKY_NOTE_MARK]: true },
    });
  });

  it("carries a rounded corner", () => {
    expect(note).toMatchObject({ roundness: { type: 3 } });
  });

  it("carries a non-empty label, which is what creates the bound text", () => {
    // `convertToExcalidrawElements` only builds the bound text container when
    // `label.text` is truthy, so the empty string would silently give us a bare
    // rectangle and lose the centring and the font size for everyone.
    const label = (note as { label?: { text: string } }).label;
    expect(label?.text).toBeTruthy();
  });

  it("gives the label its own ink instead of inheriting the container's", () => {
    // Excalidraw builds the bound text with
    // `strokeColor: label.strokeColor || container.strokeColor`, and on a text
    // element `strokeColor` IS the colour of the letters. The container is
    // deliberately transparent so the square has no outline, so a label without
    // its own colour produced invisible text: present, editable, selectable and
    // impossible to read. Nothing about the rendered rectangle looked wrong.
    const label = (note as { label?: { strokeColor?: string } }).label;
    const container = note as { strokeColor?: string };

    expect(container.strokeColor).toBe("transparent");
    expect(label?.strokeColor).toBe(STICKY_NOTE_TEXT_COLOR);
    expect(label?.strokeColor).not.toBe(container.strokeColor);
  });

  it("invents no version, versionNonce or seed", () => {
    // Those three are what reconciliation uses to decide whose copy of an
    // element wins. Excalidraw generates them; making them up here is how two
    // students editing the same note would stop converging.
    expect(note).not.toHaveProperty("version");
    expect(note).not.toHaveProperty("versionNonce");
    expect(note).not.toHaveProperty("seed");
  });
});

describe("telling a note from a rectangle", () => {
  it("recognises its own mark", () => {
    expect(
      isStickyNote({ type: "rectangle", customData: { [STICKY_NOTE_MARK]: true } }),
    ).toBe(true);
  });

  it("does not claim a hand-drawn rectangle", () => {
    expect(isStickyNote({ type: "rectangle" })).toBe(false);
    expect(isStickyNote({ type: "rectangle", customData: null })).toBe(false);
    expect(isStickyNote({ type: "rectangle", customData: {} })).toBe(false);
  });

  it("does not claim another shape that happens to carry the mark", () => {
    expect(
      isStickyNote({ type: "ellipse", customData: { [STICKY_NOTE_MARK]: true } }),
    ).toBe(false);
  });
});

describe("the colour rule", () => {
  const note = (id: string, backgroundColor: string, isDeleted = false) => ({
    id,
    type: "rectangle",
    backgroundColor,
    isDeleted,
    version: 7,
    customData: { [STICKY_NOTE_MARK]: true },
  });

  const rectangle = (id: string, backgroundColor: string) => ({
    id,
    type: "rectangle",
    backgroundColor,
    isDeleted: false,
    version: 7,
  });

  const nonce = () => 4242;

  it("repaints the selected notes and leaves the rest alone", () => {
    const result = recolourSelectedStickyNotes(
      [note("a", YELLOW), note("b", YELLOW)],
      { a: true },
      GREEN,
      nonce,
    );
    expect(result?.map((element) => element.backgroundColor)).toEqual([
      GREEN,
      YELLOW,
    ]);
  });

  it("bumps the version and refreshes the nonce, like every other edit", () => {
    // This is what makes the change flush to the class at all, and what lets
    // reconciliation order it against a peer's edit to the same note.
    const result = recolourSelectedStickyNotes(
      [note("a", YELLOW)],
      { a: true },
      GREEN,
      nonce,
    );
    expect(result?.[0]).toMatchObject({ version: 8, versionNonce: 4242 });
  });

  it("never touches a rectangle somebody drew by hand", () => {
    // The swatch row is the sticky-note tool, not a general fill picker.
    // Silently recolouring a student's diagram is worse than doing nothing.
    expect(
      recolourSelectedStickyNotes(
        [rectangle("a", "#ffffff")],
        { a: true },
        GREEN,
        nonce,
      ),
    ).toBeNull();
  });

  it("never touches a deleted note", () => {
    expect(
      recolourSelectedStickyNotes(
        [note("a", YELLOW, true)],
        { a: true },
        GREEN,
        nonce,
      ),
    ).toBeNull();
  });

  it("ignores an id whose selection flag is false", () => {
    expect(
      recolourSelectedStickyNotes([note("a", YELLOW)], { a: false }, GREEN, nonce),
    ).toBeNull();
  });

  it("reports no change when the note already has that colour", () => {
    // A null result is how the caller skips the updateScene entirely, so a
    // pointless click costs the other 24 students no broadcast.
    expect(
      recolourSelectedStickyNotes([note("a", GREEN)], { a: true }, GREEN, nonce),
    ).toBeNull();
  });

  it("reports no change when nothing is selected", () => {
    expect(
      recolourSelectedStickyNotes([note("a", YELLOW)], {}, GREEN, nonce),
    ).toBeNull();
  });
});

describe("the stored colour preference", () => {
  it("accepts a colour from the palette", () => {
    expect(isStickyNoteColor(GREEN)).toBe(true);
    expect(readStickyNoteColor(GREEN)).toBe(GREEN);
  });

  it("falls back when localStorage holds nothing, or junk", () => {
    expect(readStickyNoteColor(null)).toBe(DEFAULT_STICKY_NOTE_COLOR);
    expect(readStickyNoteColor("#000000")).toBe(DEFAULT_STICKY_NOTE_COLOR);
    expect(readStickyNoteColor("")).toBe(DEFAULT_STICKY_NOTE_COLOR);
  });
});

describe("the shortcut guard", () => {
  const idle: StickyEditingState = {
    editingTextElement: null,
    editingFrame: null,
    editingLinearElement: null,
    openDialog: null,
  };

  const key = (over: Partial<StickyKeyEvent> = {}): StickyKeyEvent => ({
    key: "N",
    shiftKey: true,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    target: null,
    ...over,
  });

  const writable = { canWrite: true, editing: idle };

  it("fires on Shift+N over an idle canvas", () => {
    expect(shouldCreateStickyNote(key(), writable)).toBe(true);
  });

  it("accepts the key in either case", () => {
    expect(shouldCreateStickyNote(key({ key: "n" }), writable)).toBe(true);
  });

  it("ignores a bare n, which Excalidraw may claim for a tool one day", () => {
    expect(shouldCreateStickyNote(key({ shiftKey: false }), writable)).toBe(
      false,
    );
  });

  it("ignores any other key", () => {
    for (const other of ["R", "Enter", "1", "T", "Escape"]) {
      expect(shouldCreateStickyNote(key({ key: other }), writable)).toBe(false);
    }
  });

  it("ignores the modified forms, which belong to the browser and Excalidraw", () => {
    expect(shouldCreateStickyNote(key({ ctrlKey: true }), writable)).toBe(false);
    expect(shouldCreateStickyNote(key({ metaKey: true }), writable)).toBe(false);
    expect(shouldCreateStickyNote(key({ altKey: true }), writable)).toBe(false);
  });

  it("ignores an autorepeat, so holding the keys is one note", () => {
    expect(shouldCreateStickyNote(key({ repeat: true }), writable)).toBe(false);
  });

  describe("while the user is typing", () => {
    // Without this a student writing "Anna" into a note gets a new note for
    // the n. Excalidraw's text editor is a real textarea over the canvas, so
    // both halves of the check see it.

    it("is suppressed when the event target is a text entry", () => {
      for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
        expect(shouldCreateStickyNote(key({ target: { tagName } }), writable)).toBe(
          false,
        );
      }
      expect(
        shouldCreateStickyNote(
          key({ target: { tagName: "DIV", isContentEditable: true } }),
          writable,
        ),
      ).toBe(false);
    });

    it("is not suppressed by an ordinary element", () => {
      expect(
        shouldCreateStickyNote(
          key({ target: { tagName: "DIV", isContentEditable: false } }),
          writable,
        ),
      ).toBe(true);
    });

    it("is suppressed by every editing mode Excalidraw reports", () => {
      const modes: (keyof StickyEditingState)[] = [
        "editingTextElement",
        "editingFrame",
        "editingLinearElement",
        "openDialog",
      ];
      for (const mode of modes) {
        expect(
          shouldCreateStickyNote(key(), {
            canWrite: true,
            editing: { ...idle, [mode]: { anything: true } },
          }),
        ).toBe(false);
      }
    });
  });

  it("is suppressed while the canvas has not reported its state yet", () => {
    // No app state means no way to know whether a note is being typed into.
    expect(
      shouldCreateStickyNote(key(), { canWrite: true, editing: null }),
    ).toBe(false);
  });

  it("is suppressed when this client may not write", () => {
    // A reflection of the server's answer, never the enforcement: the
    // collaboration server re-reads getBoardAccess for every update it
    // receives and drops this one regardless of what the client believes.
    expect(
      shouldCreateStickyNote(key(), { canWrite: false, editing: idle }),
    ).toBe(false);
  });
});
