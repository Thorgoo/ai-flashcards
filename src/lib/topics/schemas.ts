import { z } from "zod";

// Limits shared by the API, the UI and the AI task; they match the checks in the
// create_topics_and_subtopics migration.
export const TOPIC_NAME_MAX = 100;
export const SCOPE_NOTE_MAX = 500;
export const SUBTOPIC_NAME_MAX = 100;
// A confirmed list has 2-10 subtopics; manual edits stay within these bounds.
export const SUBTOPICS_MIN = 2;
export const SUBTOPICS_MAX = 10;
// The AI proposes 4-8, leaving room to add or remove by hand.
export const AI_SUBTOPICS_MIN = 4;
export const AI_SUBTOPICS_MAX = 8;

export const CONTENT_TYPES = ["conceptual", "vocabulary"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

const subtopicName = z.string().trim().min(1).max(SUBTOPIC_NAME_MAX);
const contentType = z.enum(CONTENT_TYPES);

export const createTopicInput = z.object({
  name: z.string().trim().min(1).max(TOPIC_NAME_MAX),
  scopeNote: z
    .string()
    .trim()
    .max(SCOPE_NOTE_MAX)
    .nullish()
    .transform((note) => (note === "" ? null : (note ?? null))),
});

export const addSubtopicInput = z.object({ name: subtopicName, contentType });

export const updateSubtopicInput = z
  .object({ name: subtopicName.optional(), contentType: contentType.optional() })
  .refine((input) => input.name !== undefined || input.contentType !== undefined, {
    message: "name or contentType is required",
  });

export type CreateTopicInput = z.infer<typeof createTopicInput>;
export type AddSubtopicInput = z.infer<typeof addSubtopicInput>;
export type UpdateSubtopicInput = z.infer<typeof updateSubtopicInput>;
