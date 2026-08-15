"use client";

import { useActionState, useMemo, useRef, useState } from "react";
import type { ActionState } from "../../actions";

export interface PickableUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

export interface BatchMembersFormProps {
  boardId: string;
  people: PickableUser[];
  action: (
    previous: ActionState,
    formData: FormData,
  ) => Promise<ActionState>;
  submitLabel: string;
  emptyLabel: string;
  pasteHint: string;
}

/**
 * Multi-select plus a paste box, for one direction of membership.
 *
 * The list and the textarea feed the SAME submission on purpose: in front of a
 * class a teacher wants to paste the roster and tick the two people who joined
 * late, and hit the button once. Everything the form sends is re-checked and
 * re-authorised on the server; this component only decides what is convenient.
 */
export function BatchMembersForm({
  boardId,
  people,
  action,
  submitLabel,
  emptyLabel,
  pasteHint,
}: BatchMembersFormProps) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    action,
    {},
  );
  const [filter, setFilter] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  /**
   * Filtering hides rows, it never unmounts them: a person ticked before the
   * filter was typed stays ticked, and is still submitted. Losing a selection
   * because the teacher searched for the next name would be maddening.
   */
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return new Set(
      people
        .filter(
          (person) =>
            needle.length === 0 ||
            person.displayName.toLowerCase().includes(needle) ||
            person.email.toLowerCase().includes(needle),
        )
        .map((person) => person.id),
    );
  }, [people, filter]);

  function setAll(checked: boolean) {
    const form = formRef.current;
    if (!form) return;
    for (const input of form.querySelectorAll<HTMLInputElement>(
      'input[name="userId"]',
    )) {
      // Only what is on screen: ticking a filtered-out person would be a lie.
      if (!visible.has(input.value)) continue;
      input.checked = checked;
    }
  }

  return (
    <form action={formAction} ref={formRef}>
      <input type="hidden" name="boardId" value={boardId} />

      {state.error ? <p className="error">{state.error}</p> : null}
      {state.message ? (
        <p className="muted" role="status">
          {state.message}
        </p>
      ) : null}

      {people.length === 0 ? (
        <p className="muted">{emptyLabel}</p>
      ) : (
        <>
          <div className="row batch-controls">
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter by name or email"
              aria-label="Filter people"
            />
            <button type="button" onClick={() => setAll(true)}>
              Select all
            </button>
            <button type="button" onClick={() => setAll(false)}>
              Clear
            </button>
          </div>

          <ul className="batch-picker">
            {people.map((person) => (
              <li key={person.id} hidden={!visible.has(person.id)}>
                <label>
                  <input type="checkbox" name="userId" value={person.id} />
                  <span>{person.displayName}</span>
                  <span className="muted">{person.email}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}

      <label className="batch-paste">
        <span className="muted">{pasteHint}</span>
        <textarea
          name="emails"
          rows={4}
          placeholder={"ada@example.com, grace@example.com\nalan@example.com"}
        />
      </label>

      <button className="primary" type="submit" disabled={pending}>
        {pending ? "Working…" : submitLabel}
      </button>
    </form>
  );
}
