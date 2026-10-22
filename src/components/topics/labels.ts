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
