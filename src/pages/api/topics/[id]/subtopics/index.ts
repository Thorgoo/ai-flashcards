import type { APIRoute } from "astro";
import { topicErrorResponse } from "@/lib/topics/errors";
import { loadTopic, readJson, requireSession, topicState } from "@/lib/topics/http";
import { addSubtopic } from "@/lib/topics/repository";
import { addSubtopicInput, SUBTOPICS_MAX } from "@/lib/topics/schemas";

export const POST: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const input = await readJson(context.request, addSubtopicInput);
  if (input instanceof Response) return input;

  const found = await loadTopic(session.supabase, context.params.id);
  if (found instanceof Response) return found;
  if (found.topic.status !== "draft") return topicErrorResponse("topic_locked");
  if (found.subtopics.length >= SUBTOPICS_MAX) return topicErrorResponse("subtopic_count");

  const position = Math.max(-1, ...found.subtopics.map((subtopic) => subtopic.position)) + 1;
  const added = await addSubtopic(session.supabase, found.topic.id, position, input);
  if (!added.ok) return topicErrorResponse(added.code);
  return topicState(session.supabase, found.topic.id);
};
