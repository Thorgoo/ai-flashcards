import type { APIRoute } from "astro";
import { topicErrorResponse } from "@/lib/topics/errors";
import { loadTopic, readJson, requireSession } from "@/lib/topics/http";
import { renameTopic, setTopicArchived } from "@/lib/topics/repository";
import { updateTopicInput } from "@/lib/topics/schemas";

// Renames a topic, or archives/restores it. An archived topic only accepts being restored;
// archiving it again answers its current state.
export const PATCH: APIRoute = async (context) => {
  const session = requireSession(context);
  if (session instanceof Response) return session;

  const found = await loadTopic(session.supabase, context.params.id, { allowArchived: true });
  if (found instanceof Response) return found;

  const input = await readJson(context.request, updateTopicInput);
  if (input instanceof Response) return input;

  const archived = found.topic.archivedAt !== null;
  if ("archived" in input) {
    if (archived && input.archived) return Response.json({ data: found.topic });
  } else if (archived) {
    return topicErrorResponse("topic_archived");
  }

  const updated =
    "archived" in input
      ? await setTopicArchived(session.supabase, found.topic.id, input.archived)
      : await renameTopic(session.supabase, found.topic.id, input.name);
  if (!updated.ok) return topicErrorResponse(updated.code);
  if (!updated.value) return topicErrorResponse("not_found");
  return Response.json({ data: updated.value });
};
