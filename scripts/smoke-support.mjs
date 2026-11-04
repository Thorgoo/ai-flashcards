// Shared by the smoke scripts that act as signed-in users: the service-role client, test accounts,
// the HTTP client and the PASS/FAIL report. OAuth cannot run in CI, so test accounts are created
// with the local Supabase admin API and signed in with a password; @supabase/ssr writes the session
// cookies exactly as the app reads them.
// CI only (needs a local Supabase): BASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createServerClient, serializeCookieHeader } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4321";
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

export const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// The account's AI generations so far (ai_calls rows of kind 'generation').
export async function generationCalls(userId) {
  const { count, error } = await admin
    .from("ai_calls")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("kind", "generation");
  if (error) throw new Error(`counting generations failed: ${error.message}`);
  return count;
}

// Creates the account and signs it in. `cookie` is for the app's routes, `client` calls the
// database's functions as this user.
export async function signIn(email) {
  const password = randomUUID();
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(`creating ${email} failed: ${created.error.message}`);

  const jar = new Map();
  const client = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw new Error(`signing in ${email} failed: ${signedIn.error.message}`);
  // The session cookie is written from the auth state event, which may land after signIn resolves.
  for (let i = 0; i < 50 && ![...jar.keys()].some((name) => name.includes("auth-token")); i++) {
    await sleep(20);
  }
  if (jar.size === 0) throw new Error(`no session cookie for ${email}`);

  const cookie = [...jar].map(([name, value]) => serializeCookieHeader(name, value, {}).split(";")[0]).join("; ");
  return { userId: created.data.user.id, cookie, client };
}

// Flashcard batches are generated in the queue consumer: POST answers 202 at once. Polls the
// summary as the page does until the claim ends (bounded), then reads the full state.
export async function waitForBatch(topic, cookie, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let summary;
  do {
    await sleep(500);
    summary = await api(`${topic}/flashcards/summary`, { method: "GET", cookie });
  } while (summary.status === 200 && summary.json?.data?.generating && Date.now() < deadline);
  return api(`${topic}/flashcards`, { method: "GET", cookie });
}

export async function api(path, { method = "POST", body, cookie } = {}) {
  const response = await fetch(BASE_URL + path, {
    method,
    redirect: "manual",
    headers: {
      Origin: BASE_URL,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // HTML pages and redirects have no JSON body.
  }
  return { status: response.status, json, text, headers: response.headers };
}

let failed = 0;

export function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    failed++;
    console.log(`      ${detail}`);
  }
  return ok;
}

// A step that threw, so the rest of the script could not run.
export function recordFailure(error) {
  failed++;
  console.log(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
}

export function failureCount() {
  return failed;
}

export function describe(response) {
  return `status ${response.status}, body ${JSON.stringify(response.json ?? response.text.slice(0, 200))}`;
}
