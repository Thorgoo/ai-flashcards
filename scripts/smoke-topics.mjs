// Smoke test of the topic flow as a signed-in user: create a topic, generate (AI_MODE=fake),
// edit, regenerate, confirm, the lock, another account, and the daily generation limit
// against the real PostgREST. OAuth cannot run in CI, so test accounts are created with the
// local Supabase admin API and signed in with a password; @supabase/ssr writes the session
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

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const GENERATION_LIMIT = 20;

async function signIn(email) {
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
  return { userId: created.data.user.id, cookie };
}

async function api(path, { method = "POST", body, cookie } = {}) {
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
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    failed++;
    console.log(`      ${detail}`);
  }
  return ok;
}

function describe(response) {
  return `status ${response.status}, body ${JSON.stringify(response.json ?? response.text.slice(0, 200))}`;
}

const userIds = [];
try {
  const a = await signIn("smoke@example.com");
  const b = await signIn("smoke-b@example.com");
  userIds.push(a.userId, b.userId);

  let r = await api("/api/topics", { body: { name: "Kubernetes" } });
  check(
    "create without a session is refused",
    r.status === 401 && r.json?.error?.code === "unauthenticated",
    describe(r),
  );

  r = await api("/api/topics", { body: { name: "   " }, cookie: a.cookie });
  check("empty topic name is refused", r.status === 400 && r.json?.error?.code === "validation_failed", describe(r));

  r = await api("/api/topics", { body: { name: "Kubernetes", scopeNote: "podstawy" }, cookie: a.cookie });
  const topicId = r.json?.data?.id;
  if (!check("create a topic", r.status === 201 && typeof topicId === "string", describe(r)))
    throw new Error("no topic");
  const topic = `/api/topics/${topicId}`;

  r = await api(`${topic}/generate`, { cookie: a.cookie });
  const generated = r.json?.data?.subtopics ?? [];
  check(
    "generate subtopics (fake AI)",
    r.status === 200 &&
      r.headers.get("X-AI-Mode") === "fake" &&
      generated.length >= 4 &&
      generated.length <= 8 &&
      r.json?.remaining === GENERATION_LIMIT - 1,
    describe(r),
  );

  const [first, second] = generated;
  r = await api(`${topic}/subtopics/${first.id}`, { method: "PATCH", body: { name: "Pody" }, cookie: a.cookie });
  check("rename a subtopic", r.status === 200 && r.json?.data?.subtopics?.[0]?.name === "Pody", describe(r));

  r = await api(`${topic}/subtopics/${second.id}`, {
    method: "PATCH",
    body: { contentType: "vocabulary" },
    cookie: a.cookie,
  });
  check(
    "correct a content type",
    r.status === 200 && r.json?.data?.subtopics?.[1]?.contentType === "vocabulary",
    describe(r),
  );

  r = await api(`${topic}/subtopics`, { body: { name: "Helm", contentType: "conceptual" }, cookie: a.cookie });
  const afterAdd = r.json?.data?.subtopics ?? [];
  check(
    "add a subtopic at the end",
    r.status === 200 && afterAdd.length === generated.length + 1 && afterAdd.at(-1)?.name === "Helm",
    describe(r),
  );

  r = await api(`${topic}/subtopics`, { body: { name: "helm", contentType: "conceptual" }, cookie: a.cookie });
  check(
    "duplicate subtopic name is refused",
    r.status === 409 && r.json?.error?.code === "duplicate_subtopic",
    describe(r),
  );

  r = await api(`${topic}/subtopics/${afterAdd.at(-1)?.id}`, { method: "DELETE", cookie: a.cookie });
  check("delete a subtopic", r.status === 200 && r.json?.data?.subtopics?.length === generated.length, describe(r));

  r = await api(`${topic}/generate`, { cookie: a.cookie });
  check(
    "regenerate replaces the edited list",
    r.status === 200 &&
      JSON.stringify(r.json?.data?.subtopics?.map((s) => s.name)) === JSON.stringify(generated.map((s) => s.name)),
    describe(r),
  );

  r = await api(`${topic}/generate`, { cookie: b.cookie });
  check("another account cannot generate for the topic", r.status === 404, describe(r));
  r = await api(`${topic}/subtopics/${first.id}`, { method: "PATCH", body: { name: "Obcy" }, cookie: b.cookie });
  check("another account cannot edit the topic", r.status === 404, describe(r));

  r = await api(`${topic}/confirm`, { cookie: a.cookie });
  check("confirm the list", r.status === 200 && r.json?.data?.topic?.status === "confirmed", describe(r));

  r = await api(`${topic}/subtopics`, { body: { name: "Po fakcie", contentType: "conceptual" }, cookie: a.cookie });
  check("a confirmed list cannot be extended", r.status === 409 && r.json?.error?.code === "topic_locked", describe(r));
  r = await api(`${topic}/generate`, { cookie: a.cookie });
  check(
    "a confirmed list cannot be regenerated",
    r.status === 409 && r.json?.error?.code === "topic_locked",
    describe(r),
  );

  // Diagnostic quiz (S-03).
  r = await api("/api/topics", { body: { name: "Docker" }, cookie: a.cookie });
  const draft = `/api/topics/${r.json?.data?.id}`;
  r = await api(`${draft}/quiz`, { cookie: a.cookie });
  check(
    "a draft topic cannot start a quiz",
    r.status === 409 && r.json?.error?.code === "topic_not_confirmed",
    describe(r),
  );
  r = await api(`${draft}/quiz`, { method: "GET", cookie: a.cookie });
  check("a topic without a quiz has no quiz state", r.status === 200 && r.json?.data === null, describe(r));

  r = await api(`${topic}/quiz`, { cookie: a.cookie });
  check(
    "start the quiz (fake AI) without revealing answers",
    r.status === 200 &&
      r.headers.get("X-AI-Mode") === "fake" &&
      r.json?.data?.quiz?.total === 10 &&
      typeof r.json?.data?.question?.id === "string" &&
      r.json?.remaining === GENERATION_LIMIT - 3 &&
      !r.text.includes("correctIndex"),
    describe(r),
  );
  const firstQuestion = r.json?.data?.question?.id;
  let state = r;
  r = await api(`${topic}/quiz`, { method: "GET", cookie: a.cookie });
  check(
    "the quiz state is read back for the quiz page",
    r.status === 200 &&
      r.json?.data?.quiz?.status === "ready" &&
      r.json?.data?.question?.id === firstQuestion &&
      !r.text.includes("correctIndex"),
    describe(r),
  );
  for (let i = 0; i < 10 && state.json?.data?.question; i++) {
    const answer = i % 3 === 0 ? "dont_know" : 0;
    state = await api(`${topic}/quiz/answer`, {
      body: { questionId: state.json.data.question.id, answer },
      cookie: a.cookie,
    });
  }
  const results = state.json?.data?.results ?? [];
  const review = state.json?.data?.review ?? [];
  check(
    "answering 10 questions completes the quiz with results and review",
    state.status === 200 &&
      state.json?.data?.quiz?.completedAt !== null &&
      results.reduce((sum, row) => sum + row.asked, 0) === 10 &&
      results.reduce((sum, row) => sum + row.dontKnow, 0) === 4 &&
      review.length === 10 &&
      review.every((item) => typeof item.correctIndex === "number"),
    describe(state),
  );

  r = await api(`${topic}/quiz/answer`, { body: { questionId: firstQuestion, answer: 1 }, cookie: a.cookie });
  check("an answer is final", r.status === 409 && r.json?.error?.code === "question_locked", describe(r));
  r = await api(`${topic}/quiz`, { cookie: a.cookie });
  check("a topic gets only one quiz", r.status === 409 && r.json?.error?.code === "quiz_exists", describe(r));
  r = await api(`${topic}/quiz/answer`, { body: { questionId: firstQuestion, answer: 0 }, cookie: b.cookie });
  check("another account cannot answer the quiz", r.status === 404, describe(r));

  // Three generations used so far (generate, regenerate, quiz); refused calls must not count.
  const generations = [];
  for (let i = 4; i <= GENERATION_LIMIT + 1; i++) {
    generations.push(await api(`${draft}/generate`, { cookie: a.cookie }));
  }
  const lastAllowed = generations.at(-2);
  const refused = generations.at(-1);
  check(
    `generations 4-${GENERATION_LIMIT} are allowed`,
    generations.slice(0, -1).every((res) => res.status === 200) && lastAllowed?.json?.remaining === 0,
    lastAllowed ? describe(lastAllowed) : "no results",
  );
  check(
    `generation ${GENERATION_LIMIT + 1} hits the daily limit`,
    refused?.status === 429 &&
      refused.json?.error?.code === "quota_exceeded" &&
      refused.json?.error?.retryable === false,
    refused ? describe(refused) : "no result",
  );

  r = await api("/dashboard", { method: "GET", cookie: a.cookie });
  check(
    "dashboard lists the account's topics",
    r.status === 200 && r.text.includes("Kubernetes") && r.text.includes("Docker"),
    `status ${r.status}`,
  );

  r = await api(`/topics/${topicId}`, { method: "GET", cookie: b.cookie });
  check("another account gets 404 on the topic page", r.status === 404, `status ${r.status}`);
} catch (error) {
  failed++;
  console.log(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
} finally {
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id);
  }
}

console.log(failed ? `\n${failed} step(s) failed` : "\nAll topic smoke steps passed");
process.exit(failed ? 1 : 0);
