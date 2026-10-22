import type { APIContext } from "astro";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { z } from "zod";
import { createClient } from "@/lib/supabase";
import { topicErrorResponse } from "./errors";
import { getTopic, type TopicWithSubtopics } from "./repository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Session {
  supabase: SupabaseClient;
  user: User;
}

// API routes answer 401 JSON instead of redirecting (the middleware only redirects pages).
export function requireSession(context: APIContext): Session | Response {
  const user = context.locals.user;
  const supabase = createClient(context.request.headers, context.cookies);
  if (!user || !supabase) {
    return topicErrorResponse("unauthenticated");
  }
  return { supabase, user };
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T | Response> {
  if (!request.headers.get("Content-Type")?.includes("application/json")) {
    return topicErrorResponse("validation_failed");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return topicErrorResponse("validation_failed");
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : topicErrorResponse("validation_failed");
}

// Loads the topic named in the route, or the 404 response. A malformed id is also a 404.
export async function loadTopic(
  supabase: SupabaseClient,
  id: string | undefined,
): Promise<TopicWithSubtopics | Response> {
  if (!id || !UUID.test(id)) {
    return topicErrorResponse("not_found");
  }
  const found = await getTopic(supabase, id);
  return found ?? topicErrorResponse("not_found");
}

// Every mutation answers with the topic's full current state, so the client never
// assembles state on its own.
export async function topicState(supabase: SupabaseClient, id: string): Promise<Response> {
  const found = await getTopic(supabase, id);
  return found ? Response.json({ data: found }) : topicErrorResponse("not_found");
}
