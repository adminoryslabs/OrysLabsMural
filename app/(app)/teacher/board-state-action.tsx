"use client";

import { useEffect, useState, useTransition } from "react";
import type { BoardStatus } from "@/lib/db/schema";
import { changeBoardStatusAction } from "./actions";

/** The button offers the next action, not the current state. */
const NEXT: Record<BoardStatus, { status: BoardStatus; label: string }> = {
  active: { status: "frozen", label: "Freeze" },
  frozen: { status: "readonly", label: "Read only" },
  readonly: { status: "active", label: "Reopen" },
};

export interface BoardStateActionProps {
  boardId: string;
  boardTitle: string;
  /** The board's state as the server last rendered it. */
  status: BoardStatus;
  /** How many people are connected right now, from the session log. */
  onlineCount: number;
}

/**
 * Changing a board's state from the dashboard, without opening it.
 *
 * The click is reflected immediately because the teacher is standing in front
 * of a class, but the optimistic value is only ever a guess: `status` is the
 * server's answer, and the effect below drops the guess as soon as the
 * revalidated page brings a new one. A failure reverts and says so next to the
 * control, not in a toast that has lost the context.
 *
 * Freezing stops everyone mid-sentence, so it asks first when anyone is
 * actually connected.
 */
export function BoardStateAction({
  boardId,
  boardTitle,
  status,
  onlineCount,
}: BoardStateActionProps) {
  const [optimistic, setOptimistic] = useState<BoardStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Reconcile with the server. Whatever we guessed, this is the truth.
  useEffect(() => {
    setOptimistic(null);
  }, [status]);

  const current = optimistic ?? status;
  const next = NEXT[current];
  const needsConfirmation = next.status === "frozen" && onlineCount > 0;

  const commit = () => {
    setConfirming(false);
    setError(null);
    setOptimistic(next.status);
    startTransition(async () => {
      const result = await changeBoardStatusAction(boardId, next.status);
      if (result.error) {
        setOptimistic(null);
        setError(result.error);
      }
    });
  };

  if (confirming) {
    return (
      <div className="state-action">
        <div className="state-confirm" role="group" aria-label="Confirm freeze">
          <span className="state-confirm-text">
            Freeze “{boardTitle}”? {onlineCount}{" "}
            {onlineCount === 1 ? "person is" : "people are"} drawing.
          </span>
          <button className="btn-quiet" type="button" onClick={commit}>
            Freeze
          </button>
          <button
            className="btn-quiet"
            type="button"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="state-action">
      <button
        className="btn-quiet"
        type="button"
        disabled={pending}
        onClick={() => (needsConfirmation ? setConfirming(true) : commit())}
      >
        {next.label}
      </button>
      {error ? (
        <p className="state-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
