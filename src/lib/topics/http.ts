import type { APIContext } from "astro";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { z } from "zod";
import { createClient } from "@/lib/supabase";
import { topicErrorResponse } from "./errors";
import { getFlashcardState, type FlashcardState } from "./flashcard-repository";
import { getQuizState, type QuizState } from "./quiz-repository";
import { getTopic, type TopicWithSubtopics } from "./repository";
import { getStudySession, type StudySession } from "./study-repository";
import { isUuid } from "./schemas";

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
  if (!isUuid(id)) {
    return topicErrorResponse("not_found");
  }
  const found = await readTopic(supabase, id);
  return found ?? topicErrorResponse("not_found");
}

// Every mutation answers with the topic's full current state, so the client never
// assembles state on its own.
export async function topicState(supabase: SupabaseClient, id: string): Promise<Response> {
  const found = await readTopic(supabase, id);
  if (found instanceof Response) return found;
  return found ? Response.json({ data: found }) : topicErrorResponse("not_found");
}

// The topic's quiz state (null when it has no quiz), or the error response if reading fails.
export async function readQuizState(supabase: SupabaseClient, topicId: string): Promise<QuizState | null | Response> {
  try {
    return await getQuizState(supabase, topicId);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[topics] reading quiz failed", error);
    return topicErrorResponse("save_failed");
  }
}

// The topic's first flashcard batch (null without one), or the error response if reading fails.
export async function readFlashcardState(
  supabase: SupabaseClient,
  topicId: string,
): Promise<FlashcardState | null | Response> {
  try {
    return await getFlashcardState(supabase, topicId);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[topics] reading flashcards failed", error);
    return topicErrorResponse("save_failed");
  }
}

// The topic's study session, or the error response if reading fails.
export async function readStudySession(supabase: SupabaseClient, topicId: string): Promise<StudySession | Response> {
  try {
    return await getStudySession(supabase, topicId);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[topics] reading study session failed", error);
    return topicErrorResponse("save_failed");
  }
}

// A failed read still answers in the shared error shape, never with the runtime's bare 500.
async function readTopic(supabase: SupabaseClient, id: string): Promise<TopicWithSubtopics | null | Response> {
  try {
    return await getTopic(supabase, id);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[topics] reading topic failed", error);
    return topicErrorResponse("save_failed");
  }
}
