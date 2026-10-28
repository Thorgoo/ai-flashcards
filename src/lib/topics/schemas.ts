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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Route ids are checked before querying, so a malformed id is a 404, not a database error.
export function isUuid(value: string | undefined): value is string {
  return value !== undefined && UUID.test(value);
}

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

// A quiz answer: option 0-3, or "dont_know" (stored as -1).
export const quizAnswerInput = z.object({
  questionId: z.string().refine(isUuid, { message: "questionId must be a uuid" }),
  answer: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal("dont_know")]),
});

// Matches the answer_text check in the flashcard_open_answers migration.
export const OPEN_ANSWER_MAX = 2000;

const uuidField = (name: string) => z.string().refine(isUuid, { message: `${name} must be a uuid` });

// One answer in the study session: A/B/C/D (`choice`) or the user's own words (`open`).
// attemptId is the client's id of the click, reused on every retry so a repeated request
// is not counted twice. Strict, so a field of the other format is refused, not dropped.
export const studyAnswerInput = z.discriminatedUnion("format", [
  z
    .object({
      format: z.literal("choice"),
      cardId: uuidField("cardId"),
      answer: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
      attemptId: uuidField("attemptId"),
    })
    .strict(),
  z
    .object({
      format: z.literal("open"),
      cardId: uuidField("cardId"),
      answerText: z.string().trim().min(1).max(OPEN_ANSWER_MAX),
      attemptId: uuidField("attemptId"),
    })
    .strict(),
]);

export type CreateTopicInput = z.infer<typeof createTopicInput>;
export type AddSubtopicInput = z.infer<typeof addSubtopicInput>;
export type UpdateSubtopicInput = z.infer<typeof updateSubtopicInput>;
