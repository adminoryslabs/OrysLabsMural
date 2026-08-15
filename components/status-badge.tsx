import type { BoardStatus } from "@/lib/db/schema";

const LABELS: Record<BoardStatus, string> = {
  active: "Active",
  frozen: "Frozen",
  readonly: "Read only",
};

/**
 * The three server-enforced states, told apart by a 7x7 square marker: filled
 * chartreuse for active, filled ink for frozen, outlined for read only. The
 * shape carries the meaning as well as the colour, so the distinction survives
 * a projector and colour blindness alike.
 */
export function StatusDot({ status }: { status: BoardStatus }) {
  return (
    <span className={`status-dot status-dot-${status}`} aria-hidden="true" />
  );
}

export function statusLabel(status: BoardStatus): string {
  return LABELS[status];
}

export function StatusBadge({ status }: { status: BoardStatus }) {
  return (
    <span
      className={
        status === "active" ? "status-label status-label-active" : "status-label"
      }
    >
      <StatusDot status={status} />
      {LABELS[status]}
    </span>
  );
}
