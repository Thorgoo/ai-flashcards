import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { TopicErrorCode } from "./errors";
import type { AddSubtopicInput, ContentType, CreateTopicInput, UpdateSubtopicInput } from "./schemas";

export type TopicStatus = "draft" | "confirmed";

export interface Topic {
  id: string;
  name: string;
  scopeNote: string | null;
  status: TopicStatus;
  createdAt: string;
  confirmedAt: string | null;
}

export interface Subtopic {
  id: string;
  name: string;
  contentType: ContentType;
  position: number;
}

export interface TopicWithSubtopics {
  topic: Topic;
  subtopics: Subtopic[];
}

export type RepoResult<T> = { ok: true; value: T } | { ok: false; code: TopicErrorCode };

interface TopicRow {
  id: string;
  name: string;
  scope_note: string | null;
  status: TopicStatus;
  created_at: string;
  confirmed_at: string | null;
}

interface SubtopicRow {
  id: string;
  name: string;
  content_type: ContentType;
  position: number;
}

const TOPIC_COLUMNS = "id, name, scope_note, status, created_at, confirmed_at";
const SUBTOPIC_COLUMNS = "id, name, content_type, position";

function toTopic(row: TopicRow): Topic {
  return {
    id: row.id,
    name: row.name,
    scopeNote: row.scope_note,
    status: row.status,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
  };
}

function toSubtopic(row: SubtopicRow): Subtopic {
  return { id: row.id, name: row.name, contentType: row.content_type, position: row.position };
}

// SQLSTATEs raised by the create_topics_and_subtopics migration and its RLS policies.
function errorCode(error: PostgrestError): TopicErrorCode {
  switch (error.code) {
    case "P0409":
    case "42501":
      return "topic_locked";
    case "P0422":
      return "subtopic_count";
    case "23505":
      return "duplicate_subtopic";
    default:
      // eslint-disable-next-line no-console
      console.error("[topics] database error", error);
      return "save_failed";
  }
}

// All queries run as the signed-in account; RLS limits them to its own rows.
export async function listTopics(supabase: SupabaseClient): Promise<Topic[]> {
  const { data, error } = await supabase.from("topics").select(TOPIC_COLUMNS).order("created_at", { ascending: false });
  if (error) {
    throw new Error(`listing topics failed: ${error.message}`);
  }
  return (data as TopicRow[]).map(toTopic);
}

// Null when the topic does not exist or belongs to another account.
export async function getTopic(supabase: SupabaseClient, id: string): Promise<TopicWithSubtopics | null> {
  const topicResult = await supabase.from("topics").select(TOPIC_COLUMNS).eq("id", id).maybeSingle();
  if (topicResult.error) {
    throw new Error(`loading topic failed: ${topicResult.error.message}`);
  }
  if (!topicResult.data) {
    return null;
  }
  const subtopicsResult = await supabase
    .from("subtopics")
    .select(SUBTOPIC_COLUMNS)
    .eq("topic_id", id)
    .order("position");
  if (subtopicsResult.error) {
    throw new Error(`loading subtopics failed: ${subtopicsResult.error.message}`);
  }
  return {
    topic: toTopic(topicResult.data),
    subtopics: (subtopicsResult.data as SubtopicRow[]).map(toSubtopic),
  };
}

export async function createTopic(supabase: SupabaseClient, input: CreateTopicInput): Promise<RepoResult<string>> {
  const { data, error } = await supabase
    .from("topics")
    .insert({ name: input.name, scope_note: input.scopeNote })
    .select("id")
    .single<{ id: string }>();
  if (error) {
    return { ok: false, code: errorCode(error) };
  }
  return { ok: true, value: data.id };
}

// Atomic: the whole list is replaced or nothing changes (replace_subtopics).
export async function replaceSubtopics(
  supabase: SupabaseClient,
  topicId: string,
  items: { name: string; contentType: ContentType }[],
): Promise<RepoResult<Subtopic[]>> {
  const result = await supabase.rpc("replace_subtopics", {
    p_topic_id: topicId,
    p_subtopics: items.map((item) => ({ name: item.name, content_type: item.contentType })),
  });
  if (result.error) {
    return { ok: false, code: errorCode(result.error) };
  }
  return { ok: true, value: (result.data as SubtopicRow[]).map(toSubtopic) };
}

export async function addSubtopic(
  supabase: SupabaseClient,
  topicId: string,
  position: number,
  input: AddSubtopicInput,
): Promise<RepoResult<null>> {
  const { error } = await supabase
    .from("subtopics")
    .insert({ topic_id: topicId, name: input.name, content_type: input.contentType, position });
  return error ? { ok: false, code: errorCode(error) } : { ok: true, value: null };
}

export async function updateSubtopic(
  supabase: SupabaseClient,
  topicId: string,
  subtopicId: string,
  input: UpdateSubtopicInput,
): Promise<RepoResult<null>> {
  const { data, error } = await supabase
    .from("subtopics")
    .update({ name: input.name, content_type: input.contentType })
    .eq("id", subtopicId)
    .eq("topic_id", topicId)
    .select("id");
  if (error) {
    return { ok: false, code: errorCode(error) };
  }
  return data.length === 0 ? { ok: false, code: "not_found" } : { ok: true, value: null };
}

export async function deleteSubtopic(
  supabase: SupabaseClient,
  topicId: string,
  subtopicId: string,
): Promise<RepoResult<null>> {
  const { data, error } = await supabase
    .from("subtopics")
    .delete()
    .eq("id", subtopicId)
    .eq("topic_id", topicId)
    .select("id");
  if (error) {
    return { ok: false, code: errorCode(error) };
  }
  return data.length === 0 ? { ok: false, code: "not_found" } : { ok: true, value: null };
}

// The status trigger checks the 2-10 subtopic rule and makes confirmation permanent.
export async function confirmTopic(supabase: SupabaseClient, topicId: string): Promise<RepoResult<null>> {
  const { error } = await supabase.from("topics").update({ status: "confirmed" }).eq("id", topicId);
  return error ? { ok: false, code: errorCode(error) } : { ok: true, value: null };
}
