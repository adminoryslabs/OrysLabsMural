import { colorForUser, initialsOf } from "@/lib/collab/peer-color";

export interface PresencePerson {
  userId: string;
  displayName: string;
}

/**
 * A round initials chip in the person's own colour. Avatars are the single
 * exception to the design's radius of 0.
 *
 * `onSurface` picks the ring colour: the stack has to be cut out of whatever is
 * behind it, which is `--surface` on a card and `--paper` on a list row.
 */
export function Avatar({
  person,
  online = true,
  onSurface = false,
}: {
  person: PresencePerson;
  online?: boolean;
  onSurface?: boolean;
}) {
  const className = [
    "avatar",
    online ? "" : "avatar-offline",
    onSurface ? "avatar-on-surface" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={className}
      style={online ? { background: colorForUser(person.userId) } : undefined}
      title={person.displayName}
    >
      {initialsOf(person.displayName)}
    </span>
  );
}

/**
 * The overlapping stack plus its count. The label carries the real number, so
 * showing only the first few faces never lies about how many people are here.
 */
export function PresenceRow({
  people,
  max = 3,
  onSurface = false,
  emptyLabel = "Nobody here",
  label,
}: {
  people: readonly PresencePerson[];
  max?: number;
  onSurface?: boolean;
  emptyLabel?: string;
  label?: string;
}) {
  const shown = people.slice(0, max);

  return (
    <div className="presence">
      <div className="avatar-stack">
        {shown.map((person) => (
          <Avatar key={person.userId} person={person} onSurface={onSurface} />
        ))}
      </div>
      <span
        className={
          people.length === 0 ? "presence-label presence-label-empty" : "presence-label"
        }
      >
        {label ?? (people.length === 0 ? emptyLabel : `${people.length} online`)}
      </span>
    </div>
  );
}
