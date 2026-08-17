"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { changeBoardStatusAction } from "@/app/(app)/teacher/actions";
import { Avatar } from "./avatar";
import {
  AcUnitIcon,
  ArrowBackIcon,
  GroupIcon,
  ImageIcon,
  StickyNoteIcon,
  VisibilityIcon,
} from "./icons";
import { StatusBadge } from "./status-badge";
import type { BoardStatus } from "@/lib/db/schema";
import {
  STICKY_NOTE_COLORS,
  STICKY_NOTE_SHORTCUT_LABEL,
  type StickyNoteColor,
} from "@/lib/collab/sticky-note";
import { ICON_CATALOG, iconUrl } from "@/lib/collab/icon-tool";

const ORDER: readonly BoardStatus[] = ["active", "frozen", "readonly"];

const LABELS: Record<BoardStatus, string> = {
  active: "Active",
  frozen: "Frozen",
  readonly: "Read only",
};

/**
 * The teacher's in-class freeze control.
 *
 * The click is reflected immediately, but the reflection is never the truth:
 * `status` is what the collaboration server last pushed, and the effect drops
 * the optimistic guess the moment a broadcast contradicts or confirms it. The
 * websocket server re-reads the authority for every write regardless of what
 * this control is showing.
 */
export function BoardStateControl({
  boardId,
  status,
}: {
  boardId: string;
  status: BoardStatus;
}) {
  const [intent, setIntent] = useState<BoardStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setIntent(null);
  }, [status]);

  const shown = intent ?? status;

  const choose = (next: BoardStatus) => {
    if (next === shown) return;
    setError(null);
    setIntent(next);
    startTransition(async () => {
      const result = await changeBoardStatusAction(boardId, next);
      if (result.error) {
        setIntent(null);
        setError(result.error);
      }
    });
  };

  return (
    <div className="state-control-wrap">
      <div className="state-control" role="radiogroup" aria-label="Board state">
        {ORDER.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={shown === value}
            disabled={pending && intent !== null && intent !== value}
            onClick={() => choose(value)}
          >
            {LABELS[value]}
          </button>
        ))}
      </div>
      {error ? (
        <p className="state-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The strip under the top bar. Absent while the board is active. */
export function BoardStateNote({
  status,
  canAdminister,
}: {
  status: BoardStatus;
  canAdminister: boolean;
}) {
  if (status === "active") return null;

  if (status === "frozen") {
    return (
      <div className="board-note board-note-frozen" role="status">
        <AcUnitIcon size={17} />
        <span>
          {canAdminister
            ? "Frozen — nobody can edit, you included."
            : "Your instructor froze the board. Nobody can edit right now — your work is saved."}
        </span>
      </div>
    );
  }

  return (
    <div className="board-note" role="status">
      <VisibilityIcon size={17} />
      <span>
        {canAdminister
          ? "Read only — students can watch and export, but not edit."
          : "This board is read only. You can look around and export it, but not edit."}
      </span>
    </div>
  );
}

/**
 * THE STICKY-NOTE TOOL.
 *
 * It lives in our own chrome rather than in Excalidraw's toolbar, which is
 * internal and off limits: no fork, no patching. The button drops a note in the
 * middle of the current view, and the swatches choose the colour of the next
 * one — repainting the selected notes as well, which is the only way to change
 * your mind about a note you have just made without hunting through
 * Excalidraw's own property panel.
 *
 * `disabled` is the live authority the collaboration server last pushed. It is
 * the UI reflecting the server's answer and nothing more: the websocket server
 * re-reads `getBoardAccess` for every update, so a student who re-enables this
 * button in devtools gets the write dropped anyway.
 */
export function StickyNoteTool({
  color,
  onColorChange,
  onCreate,
  disabled,
}: {
  color: StickyNoteColor;
  onColorChange: (color: StickyNoteColor) => void;
  onCreate: () => void;
  disabled: boolean;
}) {
  return (
    <div className="sticky-tool" role="group" aria-label="Sticky notes">
      <button
        className="sticky-tool-add"
        type="button"
        disabled={disabled}
        onClick={onCreate}
        title={
          disabled
            ? "You cannot edit this board right now"
            : `Add a sticky note (${STICKY_NOTE_SHORTCUT_LABEL})`
        }
      >
        <StickyNoteIcon size={17} />
        <span>Note</span>
      </button>

      <div className="sticky-tool-swatches">
        {STICKY_NOTE_COLORS.map((entry) => (
          <button
            key={entry.value}
            className="sticky-swatch"
            type="button"
            disabled={disabled}
            aria-pressed={entry.value === color}
            style={{ background: entry.value }}
            onClick={() => onColorChange(entry.value)}
          >
            <span className="sr-only">{entry.label} sticky notes</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * THE ICON TOOL.
 *
 * Unlike the sticky-note swatches, this catalog is going to grow — doodle
 * icons keep getting added over time — so a fixed row of buttons does not
 * scale the way it does for six colours. A picker popup does: it opens on
 * demand, holds as many entries as the catalog ever grows to, and stays out
 * of the top bar's way the rest of the time.
 *
 * Open/closed state is local and unpersisted, unlike the session panel's: an
 * icon picker has nothing worth remembering between visits.
 *
 * `disabled` is the same reflection-not-enforcement contract as
 * `StickyNoteTool`: the server re-checks write access on its own for both the
 * element write and the file upload behind it.
 */
export function IconTool({
  onSelect,
  disabled,
}: {
  onSelect: (name: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const choose = (name: string) => {
    setOpen(false);
    onSelect(name);
  };

  return (
    <div className="icon-tool" ref={wrapRef}>
      <button
        className="icon-tool-add"
        type="button"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={disabled ? "You cannot edit this board right now" : "Add an icon"}
      >
        <ImageIcon size={17} />
        <span>Icons</span>
      </button>

      {open ? (
        <div className="icon-picker" role="dialog" aria-label="Choose an icon">
          <div className="icon-picker-grid">
            {ICON_CATALOG.map((entry) => (
              <button
                key={entry.name}
                className="icon-picker-item"
                type="button"
                onClick={() => choose(entry.name)}
              >
                <img src={iconUrl(entry.name)} alt="" width={36} height={36} />
                <span className="sr-only">{entry.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The top bar. `status` is always the live authority state, never the value the
 * page was rendered with, so a freeze reaching a silent client repaints it.
 */
export function BoardTopBar({
  boardId,
  title,
  status,
  canAdminister,
  backHref,
  presence,
  panelOpen,
  onTogglePanel,
  tools,
}: {
  boardId: string;
  title: string;
  status: BoardStatus;
  canAdminister: boolean;
  backHref: string;
  presence: React.ReactNode;
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** Board tools, rendered in the empty space between title and presence. */
  tools?: React.ReactNode;
}) {
  return (
    <div className="board-topbar">
      <Link className="btn-icon board-topbar-back" href={backHref}>
        <ArrowBackIcon size={19} />
        <span className="sr-only">Back to the boards</span>
      </Link>
      <p className="board-topbar-title">{title}</p>

      {tools}

      <div className="board-topbar-right">
        {presence}
        {canAdminister ? (
          <BoardStateControl boardId={boardId} status={status} />
        ) : (
          <StatusBadge status={status} />
        )}
        <button
          className="btn-icon panel-toggle"
          type="button"
          aria-pressed={panelOpen}
          onClick={onTogglePanel}
        >
          <GroupIcon size={19} />
          <span className="sr-only">
            {panelOpen ? "Hide the room" : "Show the room"}
          </span>
        </button>
      </div>
    </div>
  );
}

export interface RosterEntry {
  userId: string;
  displayName: string;
  online: boolean;
  /** Said so itself over awareness in the last few seconds. */
  editing: boolean;
  isSelf: boolean;
}

function rosterState(entry: RosterEntry, status: BoardStatus): string {
  if (!entry.online) return "Offline";
  if (entry.editing) return "Editing";
  if (status === "frozen") return "Frozen";
  if (status === "readonly") return "Read only";
  return "Watching";
}

/**
 * The collapsible session panel: who is in the room, who is not, and the export
 * buttons. Offline members stay listed on purpose — the panel answers "who is
 * connected and who is not", which filtering them out would destroy.
 *
 * Every state line is derived from `status`, the live authority value, so a
 * freeze relabels the whole roster in the same tick as the note appearing.
 */
export function BoardSessionPanel({
  entries,
  status,
  onExport,
  exporting,
}: {
  entries: readonly RosterEntry[];
  status: BoardStatus;
  onExport: (format: "png" | "svg") => void;
  exporting: boolean;
}) {
  const online = entries.filter((entry) => entry.online).length;

  return (
    <aside className="board-panel">
      <div className="board-panel-head">
        <h2>In the room</h2>
        <p className="board-panel-count">
          {online} of {entries.length}
        </p>
      </div>

      <ul className="board-roster">
        {entries.length === 0 ? (
          <li className="muted">No members assigned yet.</li>
        ) : null}
        {entries.map((entry) => (
          <li key={entry.userId}>
            <Avatar
              person={entry}
              online={entry.online}
            />
            <span style={{ minWidth: 0 }}>
              <span
                className={[
                  "roster-name",
                  entry.online ? "" : "roster-name-offline",
                  entry.isSelf ? "roster-name-self" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {entry.displayName}
                {entry.isSelf ? " (you)" : ""}
              </span>
              <span
                className={
                  entry.online && entry.editing
                    ? "roster-state roster-state-editing"
                    : "roster-state"
                }
              >
                {rosterState(entry, status)}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <div className="board-panel-foot">
        <button
          className="btn-text"
          type="button"
          disabled={exporting}
          onClick={() => onExport("png")}
        >
          Export PNG
        </button>
        <button
          className="btn-text"
          type="button"
          disabled={exporting}
          onClick={() => onExport("svg")}
        >
          Export SVG
        </button>
      </div>
    </aside>
  );
}
