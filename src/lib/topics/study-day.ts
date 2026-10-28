const WARSAW_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Warsaw",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// "Today" as the Europe/Warsaw calendar date (YYYY-MM-DD), for filtering reads only. The
// database computes its own (as begin_ai_call) and decides every write; around midnight the
// two may differ for a single request.
export function warsawToday(now: Date = new Date()): string {
  const parts = Object.fromEntries(WARSAW_DATE.formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
