// Smoke test of the charge rules over HTTP (AI_MODE=fake): one charge per model attempt, none for a
// refusal before AI, and a retry after a failure ends with one complete result. Each scenario has
// its own function and its own account, because it spends that account's daily generations.
// CI only (needs a local Supabase): see smoke-support.mjs. Expected charges are written out from
// prd.md (FR-028 and the daily limit), never read from the code under test.
import { randomUUID } from "node:crypto";
import {
  admin,
  api,
  check,
  describe,
  failureCount,
  generationCalls,
  recordFailure,
  signIn,
  waitForBatch,
} from "./smoke-support.mjs";

// Copy of FAKE_GENERATION_FAIL_TWICE in src/lib/ai/fixtures.ts (node cannot import the TS file);
// keep the two in step. A topic name containing it fails each generation task twice per exact
// name, within one server isolate, so every name needs a random suffix.
const FAKE_GENERATION_FAIL_TWICE = "[fake-ai-fail-twice]";

const failingName = () => `${FAKE_GENERATION_FAIL_TWICE} ${randomUUID()}`;

// A failed AI call as the API answers it, with the error the page shows (503, retryable).
const isAiFailure = (response) =>
  response.status === 503 &&
  response.headers.get("X-AI-Mode") === "fake" &&
  response.json?.error?.code === "ai_unavailable" &&
  response.json?.error?.retryable === true;

const isRefusal = (response, code) => response.status === 409 && response.json?.error?.code === code;

// The failure stored on a flashcard batch, as polling reads it.
const isStoredFailure = (response, seq) =>
  response.status === 200 &&
  response.json?.data?.generating === null &&
  response.json?.data?.failed?.seq === seq &&
  response.json?.data?.failed?.error?.code === "ai_unavailable" &&
  response.json?.data?.failed?.error?.retryable === true;

// The topic's list as stored, read with the service key.
async function storedSubtopics(topicId) {
  const { data, error } = await admin
    .from("subtopics")
    .select("id, name, content_type, position")
    .eq("topic_id", topicId)
    .order("position");
  if (error) throw new Error(`reading subtopics of ${topicId} failed: ${error.message}`);
  return data;
}

async function countRows(table, column, value) {
  const { count, error } = await admin.from(table).select("id", { count: "exact", head: true }).eq(column, value);
  if (error) throw new Error(`counting ${table} failed: ${error.message}`);
  return count;
}

// Marks cards mastered, standing in for weeks of correct answers.
async function master(ids) {
  const { error } = await admin.from("flashcards").update({ stage: "mastered" }).in("id", ids);
  if (error) throw new Error(`mastering cards failed: ${error.message}`);
}

// Risk #1: failure, failure, success for all four generation kinds, on one account.
// Charges: 3 (subtopics) + 1 (failed regeneration) + 1 (regeneration) + 3 (quiz) + 3 (batch 1)
// + 3 (batch 2) = 14. Regenerating a draft pays and replaces the whole list: that is the user's
// decision of 2026-11-04 pinned here, not a PRD requirement.
async function retryScenario({ userId, cookie }) {
  const charges = () => generationCalls(userId);
  const firstName = failingName();

  let r = await api("/api/topics", { body: { name: firstName }, cookie });
  const topicId = r.json?.data?.id;
  if (!check("create a topic with the failure marker", r.status === 201 && typeof topicId === "string", describe(r)))
    throw new Error("no topic");
  const topic = `/api/topics/${topicId}`;
  const rename = (name) => api(topic, { method: "PATCH", body: { name }, cookie });

  // Subtopics: failure, failure, success.
  for (const [attempt, expected] of [
    [1, 1],
    [2, 2],
  ]) {
    r = await api(`${topic}/generate`, { cookie });
    const rows = await storedSubtopics(topicId);
    const calls = await charges();
    check(
      `failed subtopics attempt ${attempt} saves nothing and costs one generation`,
      isAiFailure(r) && rows.length === 0 && calls === expected,
      `${describe(r)}; subtopics ${rows.length}; charges ${calls}`,
    );
  }
  r = await api(`${topic}/generate`, { cookie });
  const generated = await storedSubtopics(topicId);
  let calls = await charges();
  check(
    "the third subtopics attempt saves one complete list",
    r.status === 200 &&
      generated.length === 5 &&
      generated.map((row) => row.position).join() === "0,1,2,3,4" &&
      calls === 3,
    `${describe(r)}; subtopics ${JSON.stringify(generated)}; charges ${calls}`,
  );
  if (generated.length === 0) throw new Error("no subtopics to regenerate");

  // A failed regeneration, on a name whose key still fails, must not touch the list.
  r = await rename(failingName());
  check("rename the draft to a second marker name", r.status === 200 && r.json?.data?.status === "draft", describe(r));
  r = await api(`${topic}/generate`, { cookie });
  let rows = await storedSubtopics(topicId);
  calls = await charges();
  check(
    "a failed regeneration leaves the list identical and costs one generation",
    isAiFailure(r) && JSON.stringify(rows) === JSON.stringify(generated) && calls === 4,
    `${describe(r)}; subtopics ${JSON.stringify(rows)}; charges ${calls}`,
  );

  // Back on the first name, whose two failures are used up, regeneration succeeds.
  r = await rename(firstName);
  check("rename the draft back to the first name", r.status === 200 && r.json?.data?.name === firstName, describe(r));
  const editedName = "Edycja przed regeneracją";
  r = await api(`${topic}/subtopics/${generated[0].id}`, { method: "PATCH", body: { name: editedName }, cookie });
  check("edit a subtopic", r.status === 200 && r.json?.data?.subtopics?.[0]?.name === editedName, describe(r));
  r = await api(`${topic}/generate`, { cookie });
  rows = await storedSubtopics(topicId);
  calls = await charges();
  const oldIds = new Set(generated.map((row) => row.id));
  check(
    "a successful regeneration replaces the whole list, drops the edit and costs one generation",
    r.status === 200 &&
      JSON.stringify(rows.map((row) => row.name)) === JSON.stringify(generated.map((row) => row.name)) &&
      rows.every((row) => !oldIds.has(row.id)) &&
      calls === 5,
    `${describe(r)}; subtopics ${JSON.stringify(rows)}; charges ${calls}`,
  );

  r = await api(`${topic}/confirm`, { cookie });
  const confirmed = r.json?.data?.subtopics ?? [];
  check("confirm the list", r.status === 200 && r.json?.data?.topic?.status === "confirmed", describe(r));
  const beforeRefusal = await storedSubtopics(topicId);
  r = await api(`${topic}/generate`, { cookie });
  rows = await storedSubtopics(topicId);
  calls = await charges();
  check(
    "regenerating a confirmed list is refused for free",
    isRefusal(r, "topic_locked") && JSON.stringify(rows) === JSON.stringify(beforeRefusal) && calls === 5,
    `${describe(r)}; charges ${calls}`,
  );

  // Quiz: failure, failure, success.
  for (const [attempt, expected] of [
    [1, 6],
    [2, 7],
  ]) {
    r = await api(`${topic}/quiz`, { cookie });
    const state = await api(`${topic}/quiz`, { method: "GET", cookie });
    const quizzes = await countRows("quizzes", "topic_id", topicId);
    calls = await charges();
    check(
      `failed quiz attempt ${attempt} leaves no quiz and costs one generation`,
      isAiFailure(r) && state.status === 200 && state.json?.data === null && quizzes === 0 && calls === expected,
      `${describe(r)}; state ${describe(state)}; quizzes ${quizzes}; charges ${calls}`,
    );
  }
  r = await api(`${topic}/quiz`, { cookie });
  const quizId = r.json?.data?.quiz?.id;
  let state = r;
  const questions = quizId ? await countRows("quiz_questions", "quiz_id", quizId) : 0;
  calls = await charges();
  check(
    "the third quiz attempt saves all 10 questions",
    r.status === 200 && r.json?.data?.quiz?.total === 10 && questions === 10 && calls === 8,
    `${describe(r)}; questions ${questions}; charges ${calls}`,
  );
  r = await api(`${topic}/quiz`, { cookie });
  calls = await charges();
  check(
    "a repeated quiz is refused for free",
    isRefusal(r, "quiz_exists") && calls === 8,
    `${describe(r)}; charges ${calls}`,
  );
  for (let i = 0; i < 10 && state.json?.data?.question; i++) {
    const answer = i % 3 === 0 ? "dont_know" : 0;
    state = await api(`${topic}/quiz/answer`, {
      body: { questionId: state.json.data.question.id, answer },
      cookie,
    });
  }
  if (
    !check("complete the quiz", state.status === 200 && Boolean(state.json?.data?.quiz?.completedAt), describe(state))
  )
    throw new Error("the flashcard steps need a completed quiz");

  // First batch: failure, failure, success. Generated in the background, so failures come from polling.
  const startFirst = () => api(`${topic}/flashcards`, { cookie });
  const isStarted = (response, seq) =>
    response.status === 202 &&
    response.headers.get("X-AI-Mode") === "fake" &&
    response.json?.data?.generating?.seq === seq;
  for (const [attempt, expected] of [
    [1, 9],
    [2, 10],
  ]) {
    const started = await startFirst();
    r = await waitForBatch(topic, cookie);
    const cards = await countRows("flashcards", "topic_id", topicId);
    calls = await charges();
    check(
      `failed batch 1 attempt ${attempt} shows the error without cards and costs one generation`,
      isStarted(started, 1) &&
        isStoredFailure(r, 1) &&
        r.json?.data?.batches?.length === 0 &&
        cards === 0 &&
        calls === expected,
      `${describe(started)}; ${describe(r)}; cards ${cards}; charges ${calls}`,
    );
  }
  let started = await startFirst();
  r = await waitForBatch(topic, cookie);
  const batchOne = r.json?.data?.batches?.[0]?.cards ?? [];
  let cards = await countRows("flashcards", "topic_id", topicId);
  calls = await charges();
  check(
    "the third batch 1 attempt saves all 10 cards",
    isStarted(started, 1) &&
      r.status === 200 &&
      r.json?.data?.failed === null &&
      r.json?.data?.batches?.length === 1 &&
      batchOne.length === 10 &&
      cards === 10 &&
      calls === 11,
    `${describe(started)}; ${describe(r)}; cards ${cards}; charges ${calls}`,
  );
  r = await startFirst();
  calls = await charges();
  check(
    "a repeated batch 1 is refused for free",
    isRefusal(r, "batch_exists") && calls === 11,
    `${describe(r)}; charges ${calls}`,
  );

  // State set up with the service key: 80% of batch 1 mastered unlocks batch 2, and one card kept
  // unmastered (of the subtopic with the most cards) stops the topic counting as mastered.
  const cardsOf = (id) => batchOne.filter((item) => item.subtopicId === id);
  const largest = [...confirmed].sort((x, y) => cardsOf(y.id).length - cardsOf(x.id).length)[0];
  const kept = cardsOf(largest?.id)[0];
  const toMaster = batchOne.filter((item) => item.id !== kept?.id);
  if (!kept || toMaster.length < 8) throw new Error(`cannot set up the 80% threshold: ${describe(r)}`);
  await master(toMaster.map((item) => item.id));

  // Batch 2: failure, failure, success.
  const startNext = () => api(`${topic}/flashcards/next`, { body: { seq: 2 }, cookie });
  for (const [attempt, expected] of [
    [1, 12],
    [2, 13],
  ]) {
    started = await startNext();
    r = await waitForBatch(topic, cookie);
    cards = await countRows("flashcards", "topic_id", topicId);
    calls = await charges();
    check(
      `failed batch 2 attempt ${attempt} shows the error without new cards and costs one generation`,
      isStarted(started, 2) &&
        isStoredFailure(r, 2) &&
        r.json?.data?.batches?.length === 1 &&
        cards === 10 &&
        calls === expected,
      `${describe(started)}; ${describe(r)}; cards ${cards}; charges ${calls}`,
    );
  }
  started = await startNext();
  r = await waitForBatch(topic, cookie);
  const batchTwo = r.json?.data?.batches?.[0];
  cards = await countRows("flashcards", "topic_id", topicId);
  calls = await charges();
  check(
    "the third batch 2 attempt saves all 10 cards",
    isStarted(started, 2) &&
      r.status === 200 &&
      r.json?.data?.failed === null &&
      r.json?.data?.batches?.length === 2 &&
      batchTwo?.seq === 2 &&
      batchTwo?.cards?.length === 10 &&
      cards === 20 &&
      calls === 14,
    `${describe(started)}; ${describe(r)}; cards ${cards}; charges ${calls}`,
  );
  r = await startNext();
  calls = await charges();
  check(
    "a repeated batch 2 is refused for free, 14 generations in total",
    isRefusal(r, "batch_exists") && calls === 14,
    `${describe(r)}; charges ${calls}`,
  );
}

const userIds = [];
try {
  const retry = await signIn("smoke-retry@example.com");
  userIds.push(retry.userId);
  await retryScenario(retry);
} catch (error) {
  recordFailure(error);
} finally {
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id);
  }
}

const failed = failureCount();
console.log(failed ? `\n${failed} step(s) failed` : "\nAll retry and claim smoke steps passed");
process.exit(failed ? 1 : 0);
