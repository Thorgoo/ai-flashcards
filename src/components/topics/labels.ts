import type { ContentType } from "@/lib/topics/schemas";
import type { TopicStatus } from "@/lib/topics/repository";

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
