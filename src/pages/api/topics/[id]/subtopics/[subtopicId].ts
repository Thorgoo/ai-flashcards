import type { APIRoute } from "astro";
import { topicErrorResponse } from "@/lib/topics/errors";
import { loadTopic, readJson, requireSession, topicState } from "@/lib/topics/http";
import { deleteSubtopic, updateSubtopic } from "@/lib/topics/repository";
import { SUBTOPICS_MIN, updateSubtopicInput } from "@/lib/topics/schemas";

// Renames a subtopic and/or corrects its content type.
export const PATCH: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const input = await readJson(context.request, updateSubtopicInput);
  if (input instanceof Response) return input;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;
  if (found.topic.status !== "draft") return topicErrorResponse("topic_locked");

  const subtopicId = context.params.subtopicId ?? "";
  if (!found.subtopics.some((subtopic) => subtopic.id === subtopicId)) return topicErrorResponse("not_found");

  const updated = await updateSubtopic(session.supabase, found.topic.id, subtopicId, input);
  if (!updated.ok) return topicErrorResponse(updated.code);
  return topicState(session.supabase, found.topic.id);
};

export const DELETE: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;
  if (found.topic.status !== "draft") return topicErrorResponse("topic_locked");
  if (found.subtopics.length <= SUBTOPICS_MIN) return topicErrorResponse("subtopic_count");

  const subtopicId = context.params.subtopicId ?? "";
  if (!found.subtopics.some((subtopic) => subtopic.id === subtopicId)) return topicErrorResponse("not_found");

  const deleted = await deleteSubtopic(session.supabase, found.topic.id, subtopicId);
  if (!deleted.ok) return topicErrorResponse(deleted.code);
  return topicState(session.supabase, found.topic.id);
};
