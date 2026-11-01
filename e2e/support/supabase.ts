// Shared database access for the browser tests: the service-role client (setup and state checks
// the app cannot do itself) and small readers of the stored study state.
// Needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (local Supabase only).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const E2E_EMAIL = "e2e@example.com";

export function supabaseEnv() {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required (run the tests through `npm run e2e`)",
    );
  }
  return { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY };
}

let adminClient: SupabaseClient | undefined;

// Created on first use, so listing the tests works without a database.
export function admin(): SupabaseClient {
  if (!adminClient) {
    const env = supabaseEnv();
    adminClient = createClient(env.url, env.serviceRoleKey, { auth: { persistSession: false } });
  }
  return adminClient;
}

export interface CardState {
  stage: "choice" | "open" | "mastered";
  open_streak: number;
  due_on: string;
}

// A card's study state as stored.
export async function cardState(id: string): Promise<CardState> {
  const { data, error } = await admin().from("flashcards").select("stage, open_streak, due_on").eq("id", id).single();
  if (error) throw new Error(`reading card ${id} failed: ${error.message}`);
  return data;
}

export interface AnswerRow {
  id: string;
  format: "choice" | "open";
  answer_text: string | null;
  correct: boolean;
}

// The stored answers of a card (flashcard_answers rows), oldest first.
export async function answerRows(flashcardId: string): Promise<AnswerRow[]> {
  const { data, error } = await admin()
    .from("flashcard_answers")
    .select("id, format, answer_text, correct")
    .eq("flashcard_id", flashcardId)
    .order("answered_at");
  if (error) throw new Error(`reading answers of card ${flashcardId} failed: ${error.message}`);
  return data;
}

// The account's AI gradings so far (ai_calls rows of kind 'grading').
export async function gradings(userId: string): Promise<number> {
  const { count, error } = await admin()
    .from("ai_calls")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("kind", "grading");
  if (error) throw new Error(`counting gradings failed: ${error.message}`);
  return count ?? 0;
}

// The Europe/Warsaw calendar date (YYYY-MM-DD) offsetDays from today, the day the app's due_on uses.
export function warsawDate(offsetDays = 0): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw" }).format(new Date());
  const day = new Date(`${today}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + offsetDays);
  return day.toISOString().slice(0, 10);
}

// The id of the e2e account (created by auth.setup.ts).
export async function e2eUserId(): Promise<string> {
  const user = await findUser(E2E_EMAIL);
  if (!user) throw new Error(`${E2E_EMAIL} does not exist; the setup project creates it`);
  return user.id;
}

export async function findUser(email: string) {
  for (let page = 1; ; page++) {
    const { data, error } = await admin().auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listing users failed: ${error.message}`);
    const user = data.users.find((candidate) => candidate.email === email);
    if (user || data.users.length < 1000) return user;
  }
}
