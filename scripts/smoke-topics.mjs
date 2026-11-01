// Smoke test of the topic flow as a signed-in user: create a topic, generate (AI_MODE=fake),
// edit, regenerate, confirm, the lock, the quiz, the first flashcard batch, the study session
// (A/B/C/D answers, open answers graded by AI), the next batch, another account, and the daily
// generation limit against the real PostgREST. OAuth cannot run in CI, so test accounts are created with the
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
const GRADING_LIMIT = 100;
const BATCH_SIZE = 10;

// A card's study state as stored, read with the service key.
async function cardState(id) {
  const { data, error } = await admin.from("flashcards").select("stage, open_streak, due_on").eq("id", id).single();
  if (error) throw new Error(`reading card ${id} failed: ${error.message}`);
  return data;
}

// Moves a card's next review to `day`, standing in for days passing.
async function makeDue(id, day) {
  const { error } = await admin.from("flashcards").update({ due_on: day }).eq("id", id);
  if (error) throw new Error(`moving card ${id} failed: ${error.message}`);
}

// Puts a card in the open format with no streak and due today, standing in for a correct
// A/B/C/D answer and the days after it.
async function makeOpenDue(id, day) {
  const { error } = await admin.from("flashcards").update({ stage: "open", open_streak: 0, due_on: day }).eq("id", id);
  if (error) throw new Error(`opening card ${id} failed: ${error.message}`);
}

// The stored open answers of an attempt (flashcard_answers rows whose id is the attemptId).
async function answersOf(attemptId) {
  const { data, error } = await admin.from("flashcard_answers").select("id, answer_text").eq("id", attemptId);
  if (error) throw new Error(`reading answers of ${attemptId} failed: ${error.message}`);
  return data;
}

// Copy of FAKE_GRADING_FAIL_ONCE in src/lib/ai/fixtures.ts (node cannot import the TS file);
// keep the two in step. An answer containing it fails fake grading once per exact text.
const FAKE_GRADING_FAIL_ONCE = "[fake-ai-fail-once]";

// The account's AI gradings so far (ai_calls rows of kind 'grading').
async function gradings(userId) {
  const { count, error } = await admin
    .from("ai_calls")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("kind", "grading");
  if (error) throw new Error(`counting gradings failed: ${error.message}`);
  return count;
}

// The account's AI generations so far (ai_calls rows of kind 'generation').
async function generationCalls(userId) {
  const { count, error } = await admin
    .from("ai_calls")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("kind", "generation");
  if (error) throw new Error(`counting generations failed: ${error.message}`);
  return count;
}

// Marks cards mastered, standing in for weeks of correct answers (as makeDue does for days).
async function master(ids) {
  const { error } = await admin.from("flashcards").update({ stage: "mastered" }).in("id", ids);
  if (error) throw new Error(`mastering cards failed: ${error.message}`);
}

// Sets the topic's historical mastered-card tally (topic_mastery_tallies), standing in for
// cards mastered earlier and since deleted; the app can only read it.
async function setMasteredTally(topicId, userId, count) {
  const { error } = await admin
    .from("topic_mastery_tallies")
    .upsert({ topic_id: topicId, user_id: userId, mastered_count: count }, { onConflict: "topic_id" });
  if (error) throw new Error(`setting the mastered tally of ${topicId} failed: ${error.message}`);
}

// Copy of batchAllocation in src/lib/topics/flashcards-task.ts (node cannot import the TS
// file); keep the two in step.
function batchAllocation(percents) {
  const count = percents.length;
  const rest = BATCH_SIZE - count;
  const weights = percents.map((percent) => 100 - Math.min(100, Math.max(0, percent)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total === 0) {
    return percents.map((_, i) => 1 + Math.floor(rest / count) + (i < rest % count ? 1 : 0));
  }
  const shares = weights.map((weight) => (rest * weight) / total);
  const extra = shares.map(Math.floor);
  const left = rest - extra.reduce((sum, value) => sum + value, 0);
  const byRemainder = shares.map((_, i) => i).sort((a, b) => shares[b] - extra[b] - (shares[a] - extra[a]) || a - b);
  for (const i of byRemainder.slice(0, left)) {
    extra[i] += 1;
  }
  return extra.map((value) => value + 1);
}

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

// Flashcard batches are generated in the queue consumer: POST answers 202 at once. Polls the
// summary as the page does until the claim ends (bounded), then reads the full state.
async function waitForBatch(topic, cookie, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let summary;
  do {
    await sleep(500);
    summary = await api(`${topic}/flashcards/summary`, { method: "GET", cookie });
  } while (summary.status === 200 && summary.json?.data?.generating && Date.now() < deadline);
  return api(`${topic}/flashcards`, { method: "GET", cookie });
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
  const confirmed = r.json?.data?.subtopics ?? [];

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
  r = await api(`${topic}/flashcards`, { cookie: a.cookie });
  check(
    "flashcards cannot be generated before the quiz is completed",
    r.status === 409 && r.json?.error?.code === "quiz_not_completed",
    describe(r),
  );
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

  // First flashcard batch (S-04), split by the quiz results the API returned.
  const percentOf = new Map(results.map((row) => [row.subtopicId, row.percent]));
  const expected = batchAllocation(confirmed.map((subtopic) => percentOf.get(subtopic.id) ?? 0));
  r = await api(`${topic}/flashcards`, { cookie: a.cookie });
  check(
    "start the first flashcard batch (fake AI) in the background",
    r.status === 202 && r.headers.get("X-AI-Mode") === "fake" && r.json?.data?.generating?.seq === 1,
    describe(r),
  );
  r = await waitForBatch(topic, a.cookie);
  const cards = r.json?.data?.batches?.[0]?.cards ?? [];
  const perSubtopic = confirmed.map((subtopic) => cards.filter((card) => card.subtopicId === subtopic.id).length);
  check(
    "the first flashcard batch is saved split by the quiz results, using one generation",
    r.status === 200 &&
      r.json?.data?.batches?.length === 1 &&
      cards.length === BATCH_SIZE &&
      confirmed.length > 0 &&
      perSubtopic.every((count) => count >= 1) &&
      JSON.stringify(perSubtopic) === JSON.stringify(expected) &&
      (await generationCalls(a.userId)) === 4,
    `${describe(r)}; expected ${JSON.stringify(expected)}, got ${JSON.stringify(perSubtopic)}`,
  );
  r = await api(`${topic}/flashcards`, { cookie: a.cookie });
  check("a topic gets only one first batch", r.status === 409 && r.json?.error?.code === "batch_exists", describe(r));
  const card = cards[0]?.id;
  r = await api(`${topic}/flashcards/${card}`, { method: "DELETE", cookie: a.cookie });
  check(
    "delete a flashcard",
    r.status === 200 &&
      r.json?.data?.batches?.[0]?.cards?.length === BATCH_SIZE - 1 &&
      !r.json.data.batches[0].cards.some((item) => item.id === card),
    describe(r),
  );
  r = await api(`${topic}/flashcards/${card}`, { method: "DELETE", cookie: a.cookie });
  check(
    "a deleted flashcard is gone for good",
    r.status === 404 && r.json?.error?.code === "flashcard_not_found",
    describe(r),
  );
  r = await api(`${topic}/flashcards`, { method: "GET", cookie: b.cookie });
  check("another account cannot read the flashcards", r.status === 404, describe(r));
  r = await api(`${topic}/flashcards/summary`, { method: "GET", cookie: a.cookie });
  check(
    "the flashcard summary counts the batch without the cards' text",
    r.status === 200 &&
      r.json?.data?.readyBatches === 1 &&
      r.json.data.batches === undefined &&
      r.json.data.current?.total === BATCH_SIZE - 1 &&
      r.json.data.generating === null,
    describe(r),
  );
  r = await api(`${topic}/flashcards/summary`, { method: "GET", cookie: b.cookie });
  check("another account cannot read the flashcard summary", r.status === 404, describe(r));

  // Study session (S-05): A/B/C/D answers; it never calls AI.
  const study = `${topic}/study`;
  r = await api(study, { method: "GET", cookie: a.cookie });
  const due = r.json?.data?.cards ?? [];
  const today = r.json?.data?.today;
  check(
    "the study session lists the due cards without the deleted one",
    r.status === 200 &&
      due.length === BATCH_SIZE - 1 &&
      !due.some((item) => item.id === card) &&
      due.every((item) => item.stage === "choice") &&
      typeof today === "string",
    describe(r),
  );
  const studied = due[0];
  const right = studied?.correctIndex;
  const wrong = (right + 1) % 4;
  const correctAttempt = randomUUID();
  r = await api(`${study}/answer`, {
    body: { format: "choice", cardId: studied?.id, answer: wrong, attemptId: randomUUID() },
    cookie: a.cookie,
  });
  check(
    "a wrong answer leaves the card due and earns no badge",
    r.status === 200 &&
      r.json?.data?.correct === false &&
      r.json?.data?.stage === "choice" &&
      Array.isArray(r.json?.data?.badges) &&
      r.json.data.badges.length === 0,
    describe(r),
  );
  r = await api(study, { method: "GET", cookie: a.cookie });
  check(
    "a card answered wrong is still in the session",
    r.status === 200 && r.json?.data?.cards?.some((item) => item.id === studied?.id),
    describe(r),
  );
  r = await api(`${study}/answer`, {
    body: { format: "choice", cardId: studied?.id, answer: right, attemptId: correctAttempt },
    cookie: a.cookie,
  });
  const firstResult = r.json?.data;
  check(
    "a correct answer moves the card to the open format",
    r.status === 200 &&
      firstResult?.correct === true &&
      firstResult?.correctIndex === right &&
      firstResult?.stage === "open",
    describe(r),
  );
  r = await api(study, { method: "GET", cookie: a.cookie });
  let stored = await cardState(studied?.id);
  check(
    "a card answered correctly leaves the session and waits for the open format",
    r.status === 200 &&
      !r.json?.data?.cards?.some((item) => item.id === studied?.id) &&
      r.json?.data?.cards?.length === BATCH_SIZE - 2 &&
      stored?.stage === "open" &&
      stored.due_on > today,
    `${describe(r)}; card ${JSON.stringify(stored)}`,
  );
  r = await api(`${study}/answer`, {
    body: { format: "choice", cardId: studied?.id, answer: right, attemptId: correctAttempt },
    cookie: a.cookie,
  });
  const replay = r;
  r = await api(study, { method: "GET", cookie: a.cookie });
  const replayed = await cardState(studied?.id);
  check(
    "a retried attempt returns the same result and changes nothing",
    replay.status === 200 &&
      JSON.stringify(replay.json?.data) === JSON.stringify(firstResult) &&
      r.json?.data?.cards?.length === BATCH_SIZE - 2 &&
      JSON.stringify(replayed) === JSON.stringify(stored),
    `${describe(replay)}; ${describe(r)}; card ${JSON.stringify(replayed)}`,
  );
  r = await api(`${study}/answer`, {
    body: { format: "choice", cardId: studied?.id, answer: wrong, attemptId: randomUUID() },
    cookie: a.cookie,
  });
  check(
    "a card no longer due cannot be answered again",
    r.status === 409 && r.json?.error?.code === "card_not_due",
    describe(r),
  );
  r = await api(`${study}/answer`, {
    body: { format: "choice", cardId: card, answer: 0, attemptId: randomUUID() },
    cookie: a.cookie,
  });
  check(
    "a deleted card cannot be answered",
    r.status === 404 && r.json?.error?.code === "flashcard_not_found",
    describe(r),
  );
  r = await api(study, { method: "GET", cookie: b.cookie });
  check("another account cannot read the study session", r.status === 404, describe(r));
  r = await api(`${study}/answer`, {
    body: { format: "choice", cardId: due[1]?.id, answer: 0, attemptId: randomUUID() },
    cookie: b.cookie,
  });
  check("another account cannot answer in the study session", r.status === 404, describe(r));

  // Open answers (S-06) on the card the S-05 steps moved to the open format. Days pass by
  // moving due_on back to today with the service key (the app cannot change it).
  const open = (answerText, attemptId = randomUUID(), cookie = a.cookie) =>
    api(`${study}/answer`, { body: { format: "open", cardId: studied?.id, answerText, attemptId }, cookie });
  await makeDue(studied?.id, today);
  r = await api(study, { method: "GET", cookie: a.cookie });
  const openCard = r.json?.data?.cards?.find((item) => item.id === studied?.id);
  check(
    "a due open card is in the study session",
    r.status === 200 && openCard?.stage === "open" && openCard?.openStreak === 0,
    describe(r),
  );
  r = await open("Odpowiedź", correctAttempt);
  check(
    "an attempt of the choice format cannot be replayed as an open answer",
    r.status === 409 && r.json?.error?.code === "attempt_conflict" && (await gradings(a.userId)) === 0,
    describe(r),
  );
  const wrongAttempt = randomUUID();
  r = await open("To jest maszyna wirtualna.", wrongAttempt);
  const wrongResult = r.json?.data;
  check(
    "a wrong open answer is graded (fake AI) and keeps the streak at 0",
    r.status === 200 &&
      r.headers.get("X-AI-Mode") === "fake" &&
      wrongResult?.correct === false &&
      typeof wrongResult?.feedback === "string" &&
      wrongResult?.stage === "open" &&
      wrongResult?.openStreak === 0 &&
      r.json?.remaining === GRADING_LIMIT - 1 &&
      (await gradings(a.userId)) === 1,
    describe(r),
  );
  r = await open("To jest maszyna wirtualna.", wrongAttempt);
  check(
    "a retried open attempt returns the same result without grading again",
    r.status === 200 &&
      JSON.stringify(r.json?.data) === JSON.stringify(wrongResult) &&
      (await gradings(a.userId)) === 1,
    describe(r),
  );
  r = await open("Odpowiadam poprawnie.");
  check(
    "an open card graded today cannot be answered again the same day",
    r.status === 409 && r.json?.error?.code === "card_not_due" && (await gradings(a.userId)) === 1,
    describe(r),
  );
  await makeDue(studied?.id, today);
  r = await open("Odpowiadam poprawnie: to grupa kontenerów.");
  stored = await cardState(studied?.id);
  check(
    "a correct open answer raises the streak to 1 and moves the card 3 days on",
    r.status === 200 &&
      r.json?.data?.correct === true &&
      r.json?.data?.stage === "open" &&
      r.json?.data?.openStreak === 1 &&
      r.json?.remaining === GRADING_LIMIT - 2 &&
      stored?.open_streak === 1 &&
      stored.due_on > today,
    `${describe(r)}; card ${JSON.stringify(stored)}`,
  );
  // Badges (S-10): nine cards mastered before (the historical tally, set with the service key),
  // so mastering this one crosses the 10-card threshold and the answer returns the badge.
  await makeDue(studied?.id, today);
  await setMasteredTally(topicId, a.userId, 9);
  const masteringAttempt = randomUUID();
  r = await open("Znowu poprawnie: grupa kontenerów.", masteringAttempt);
  const masteringResult = r.json?.data;
  const badges = masteringResult?.badges ?? [];
  check(
    "a second correct open answer masters the card and earns the 10-card badge",
    r.status === 200 &&
      masteringResult?.correct === true &&
      masteringResult?.stage === "mastered" &&
      badges.length === 1 &&
      badges[0]?.kind === "mastered_cards" &&
      badges[0]?.threshold === 10 &&
      badges[0]?.topicId === null &&
      typeof badges[0]?.awardedAt === "string",
    describe(r),
  );
  const gradedBefore = await gradings(a.userId);
  r = await open("Znowu poprawnie: grupa kontenerów.", masteringAttempt);
  check(
    "a retried mastering attempt returns the same badges without grading again",
    r.status === 200 &&
      JSON.stringify(r.json?.data) === JSON.stringify(masteringResult) &&
      (await gradings(a.userId)) === gradedBefore,
    describe(r),
  );
  r = await api(study, { method: "GET", cookie: a.cookie });
  check(
    "a mastered card leaves the study session",
    r.status === 200 && !r.json?.data?.cards?.some((item) => item.id === studied?.id),
    describe(r),
  );
  r = await open("Odpowiadam poprawnie.", randomUUID(), b.cookie);
  check("another account cannot give an open answer", r.status === 404, describe(r));

  // A failed grading (fake AI fails once on the marker) must change nothing but the grading
  // limit, and the same attempt retried must then be graded and saved once.
  const retriedCard = due[1]?.id;
  await makeOpenDue(retriedCard, today);
  const before = await cardState(retriedCard);
  const gradedAtStart = await gradings(a.userId);
  const failingText = `${FAKE_GRADING_FAIL_ONCE} ${randomUUID()} odpowiadam poprawnie: obraz kontenera.`;
  const failingAttempt = randomUUID();
  const answerAgain = () =>
    api(`${study}/answer`, {
      body: { format: "open", cardId: retriedCard, answerText: failingText, attemptId: failingAttempt },
      cookie: a.cookie,
    });
  r = await answerAgain();
  const after = await cardState(retriedCard);
  let saved = await answersOf(failingAttempt);
  let graded = await gradings(a.userId);
  check(
    "a failed grading leaves the card unchanged and saves no answer",
    r.status === 503 &&
      r.json?.error?.code === "ai_unavailable" &&
      r.json?.error?.retryable === true &&
      JSON.stringify(after) === JSON.stringify(before) &&
      saved.length === 0 &&
      graded === gradedAtStart + 1,
    `${describe(r)}; card ${JSON.stringify(before)} -> ${JSON.stringify(after)}; answers ${saved.length}; gradings ${gradedAtStart} -> ${graded}`,
  );
  r = await answerAgain();
  saved = await answersOf(failingAttempt);
  graded = await gradings(a.userId);
  check(
    "a retried failed grading is graded and saved once",
    r.status === 200 &&
      r.json?.data?.correct === true &&
      typeof r.json?.data?.feedback === "string" &&
      saved.length === 1 &&
      saved[0].answer_text === failingText &&
      graded === gradedAtStart + 2,
    `${describe(r)}; answers ${JSON.stringify(saved)}; gradings ${gradedAtStart} -> ${graded}`,
  );

  // Next flashcard batches (S-07): batch 2 unlocks at 80% of batch 1 mastered and covers only
  // the subtopics not mastered yet; every refusal comes before the AI call.
  const next = `${topic}/flashcards/next`;
  let calls = await generationCalls(a.userId);
  r = await api(next, { body: { seq: 2 }, cookie: a.cookie });
  check(
    "the next batch is locked before 80% of the current one is mastered",
    r.status === 409 && r.json?.error?.code === "next_batch_locked" && (await generationCalls(a.userId)) === calls,
    describe(r),
  );
  r = await api(next, { body: { seq: 1 }, cookie: a.cookie });
  check(
    "a next batch number below 2 is refused",
    r.status === 400 && r.json?.error?.code === "validation_failed",
    describe(r),
  );

  // State set up with the service key (as makeDue): master enough batch-1 cards to reach the
  // threshold, keeping one card of the subtopic with the most cards unmastered, so that
  // subtopic stays unmastered and the others are mastered.
  r = await api(`${topic}/flashcards`, { method: "GET", cookie: a.cookie });
  const batchOne = r.json?.data?.batches?.[0]?.cards ?? [];
  const cardsOf = (id, list) => list.filter((item) => item.subtopicId === id);
  const largest = [...confirmed].sort((x, y) => cardsOf(y.id, batchOne).length - cardsOf(x.id, batchOne).length)[0];
  const kept = cardsOf(largest?.id, batchOne).find((item) => !item.mastered);
  const required = Math.ceil((batchOne.length * 4) / 5);
  const toMaster = batchOne.filter((item) => !item.mastered && item.id !== kept?.id);
  if (!kept || batchOne.length - 1 < required) throw new Error(`cannot set up the threshold: ${describe(r)}`);
  await master(toMaster.map((item) => item.id));
  // Mastered: has cards and every one is mastered (src/lib/topics/mastery.ts).
  const masteredIds = confirmed
    .filter((subtopic) => {
      const own = cardsOf(subtopic.id, batchOne);
      return own.length > 0 && own.every((item) => item.id !== kept.id);
    })
    .map((subtopic) => subtopic.id);
  const unmasteredIds = confirmed.map((subtopic) => subtopic.id).filter((id) => !masteredIds.includes(id));

  r = await api(next, { body: { seq: 2 }, cookie: a.cookie });
  check(
    "start batch 2 (fake AI) in the background",
    r.status === 202 && r.headers.get("X-AI-Mode") === "fake" && r.json?.data?.generating?.seq === 2,
    describe(r),
  );
  r = await waitForBatch(topic, a.cookie);
  const batchTwo = r.json?.data?.batches?.[0];
  const newCards = batchTwo?.cards ?? [];
  check(
    "batch 2 is saved for the unmastered subtopics only, using one generation",
    r.status === 200 &&
      r.json?.data?.batches?.length === 2 &&
      batchTwo?.seq === 2 &&
      newCards.length === BATCH_SIZE &&
      masteredIds.length > 0 &&
      !newCards.some((item) => masteredIds.includes(item.subtopicId)) &&
      unmasteredIds.every((id) => cardsOf(id, newCards).length >= 1) &&
      (await generationCalls(a.userId)) === 5,
    `${describe(r)}; mastered ${JSON.stringify(masteredIds)}, unmastered ${JSON.stringify(unmasteredIds)}`,
  );
  r = await api(next, { body: { seq: 2 }, cookie: a.cookie });
  check("a retried batch 2 is batch_exists", r.status === 409 && r.json?.error?.code === "batch_exists", describe(r));

  r = await api(`${topic}/flashcards`, { method: "GET", cookie: a.cookie });
  const allCards = (r.json?.data?.batches ?? []).flatMap((batch) => batch.cards);
  const progress = r.json?.data?.subtopics ?? [];
  check(
    "the flashcard state lists both batches with per-subtopic mastery",
    r.status === 200 &&
      r.json?.data?.batches?.length === 2 &&
      r.json.data.batches[0].seq === 2 &&
      progress.length === confirmed.length &&
      progress.every(
        (row) =>
          row.total === cardsOf(row.id, allCards).length &&
          row.mastered === cardsOf(row.id, allCards).filter((item) => item.mastered).length &&
          row.isMastered === masteredIds.includes(row.id),
      ) &&
      r.json?.data?.topicMastered === false,
    describe(r),
  );
  r = await api(next, { body: { seq: 3 }, cookie: b.cookie });
  check("another account cannot generate a next batch", r.status === 404, describe(r));

  await master(allCards.map((item) => item.id));
  calls = await generationCalls(a.userId);
  r = await api(next, { body: { seq: 3 }, cookie: a.cookie });
  check(
    "a mastered topic gets no next batch and no AI call",
    r.status === 409 && r.json?.error?.code === "topic_mastered" && (await generationCalls(a.userId)) === calls,
    describe(r),
  );

  // Home screen (FR-007): rename, archive and restore the confirmed topic. An archived topic is
  // refused by every /api/topics/[id]/* route and hidden from its pages until restored. No AI.
  r = await api(topic, { method: "PATCH", body: { name: "  Kubernetes w praktyce  " }, cookie: a.cookie });
  check(
    "rename a confirmed topic",
    r.status === 200 && r.json?.data?.name === "Kubernetes w praktyce" && r.json?.data?.status === "confirmed",
    describe(r),
  );
  r = await api(topic, { method: "PATCH", body: { name: "Obcy" }, cookie: b.cookie });
  check("another account cannot rename the topic", r.status === 404, describe(r));
  r = await api(topic, { method: "PATCH", body: { archived: true }, cookie: a.cookie });
  check("archive the topic", r.status === 200 && typeof r.json?.data?.archivedAt === "string", describe(r));
  r = await api(`${topic}/flashcards`, { method: "GET", cookie: a.cookie });
  check(
    "an archived topic is refused by its routes",
    r.status === 409 && r.json?.error?.code === "topic_archived",
    describe(r),
  );
  r = await api(`/topics/${topicId}`, { method: "GET", cookie: a.cookie });
  check(
    "an archived topic's page redirects to the dashboard",
    r.status === 302 && r.headers.get("Location") === "/dashboard",
    `status ${r.status}, location ${r.headers.get("Location")}`,
  );
  r = await api(topic, { method: "PATCH", body: { name: "Po archiwizacji" }, cookie: a.cookie });
  check(
    "an archived topic cannot be renamed",
    r.status === 409 && r.json?.error?.code === "topic_archived",
    describe(r),
  );
  r = await api(topic, { method: "PATCH", body: { archived: false }, cookie: a.cookie });
  check(
    "restore the topic",
    r.status === 200 && r.json?.data?.archivedAt === null && r.json?.data?.name === "Kubernetes w praktyce",
    describe(r),
  );
  r = await api(`${topic}/flashcards`, { method: "GET", cookie: a.cookie });
  check("a restored topic answers its routes again", r.status === 200, describe(r));

  // Five generations used so far (generate, regenerate, quiz, flashcards, batch 2; the study
  // session calls no AI and grading has its own limit); refused calls must not count.
  const generations = [];
  for (let i = 6; i <= GENERATION_LIMIT + 1; i++) {
    generations.push(await api(`${draft}/generate`, { cookie: a.cookie }));
  }
  const lastAllowed = generations.at(-2);
  const refused = generations.at(-1);
  check(
    `generations 6-${GENERATION_LIMIT} are allowed`,
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
  // Account A answered flashcards today on the Kubernetes topic, archived and restored above.
  check(
    "dashboard shows the study streak",
    r.status === 200 && r.text.includes("Seria: 1 dzień"),
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
