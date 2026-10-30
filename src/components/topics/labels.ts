import type { ContentType } from "@/lib/topics/schemas";
import type { StudyStreak, TopicStatus } from "@/lib/topics/repository";

export const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  conceptual: "Pojęciowy",
  vocabulary: "Językowy",
};

export const TOPIC_STATUS_LABELS: Record<TopicStatus, string> = {
  draft: "Szkic",
  confirmed: "Zatwierdzony",
};

// The open-format progress shown at the card's front: two correct answers in a row master it.
export function openProgressLabel(openStreak: 0 | 1): string {
  return `Odpowiedź otwarta · ${openStreak}/2`;
}

// The study entry button; a failed count (null) shows it without the number.
export function studyLabel(dueCount: number | null): string {
  return dueCount === null || dueCount === 0 ? "Ucz się" : `Ucz się (${dueCount})`;
}

// Cards due today on the home screen row.
export function dueLabel(count: number): string {
  return `Do powtórki: ${count}`;
}

// The last study day (YYYY-MM-DD) as DD.MM.YYYY; split as text, so no time zone can shift the day.
export function lastSessionLabel(date: string | null): string {
  if (date === null) return "Ostatnia sesja: —";
  const [year, month, day] = date.split("-");
  return `Ostatnia sesja: ${day}.${month}.${year}`;
}

// The streak tile on the home screen: "1 dzień", every other count "dni".
export function streakLabel(days: number): string {
  return `Seria: ${days} ${days === 1 ? "dzień" : "dni"}`;
}

// The hint under the streak; none once the account has studied today.
export function streakHint(streak: StudyStreak): string | null {
  if (streak.studiedToday) return null;
  return streak.days === 0 ? "Odpowiedz na fiszkę, aby zacząć serię" : "Ucz się dziś, aby utrzymać serię";
}
