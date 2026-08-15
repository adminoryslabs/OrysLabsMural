/**
 * Human timestamps for the board listings.
 *
 * A class runs inside a day, so the useful precision changes with age: what
 * happened this morning is a clock time, yesterday is a word, and anything
 * older is a date. Formatted on the server so every viewer of the same page
 * sees the same string; the server's timezone is the classroom's.
 */
export function formatUpdated(value: Date, now: Date = new Date()): string {
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);

  if (value >= startOfToday) {
    return `Updated ${value.getHours().toString().padStart(2, "0")}:${value
      .getMinutes()
      .toString()
      .padStart(2, "0")}`;
  }
  if (value >= startOfYesterday) {
    return "Updated yesterday";
  }
  return `Updated ${value.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(value.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  })}`;
}

/** "1 member" / "7 members". */
export function pluralize(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}
