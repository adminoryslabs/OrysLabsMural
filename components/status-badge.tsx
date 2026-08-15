import type { BoardStatus } from "@/lib/db/schema";

const LABELS: Record<BoardStatus, string> = {
  active: "Active",
  frozen: "Frozen",
  readonly: "Read only",
};

export function StatusBadge({ status }: { status: BoardStatus }) {
  return <span className={`badge badge-${status}`}>{LABELS[status]}</span>;
}
