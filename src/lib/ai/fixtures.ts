import { FLASHCARDS_TASK, NEXT_FLASHCARDS_TASK } from "@/lib/topics/flashcards-task";
import { GRADING_TASK } from "@/lib/topics/grading-task";
import { QUIZ_TASK } from "@/lib/topics/quiz-task";
import { SUBTOPICS_TASK } from "@/lib/topics/subtopics-task";
import { FakeAiFailure, type FakeFixture } from "./fake";

const LANGUAGE_TOPIC = /angielsk|niemieck|hiszpańsk|francusk|włosk|słówk|słownictw/i;

// Five subtopics derived from the topic name in the prompt; language topics get a mix
// of vocabulary and grammar, so both content types show up in dev and CI.
const subtopics: FakeFixture = (request) => {
  const topic = (/<temat>([\s\S]*?)<\/temat>/.exec(request.prompt)?.[1] ?? "Temat").trim().slice(0, 60);
  const language = LANGUAGE_TOPIC.test(topic);
  return {
    subtopics: [
      { name: `${topic}: podstawy`, contentType: "conceptual" },
      { name: `${topic}: pojęcia kluczowe`, contentType: "conceptual" },
      { name: `${topic}: słownictwo codzienne`, contentType: language ? "vocabulary" : "conceptual" },
      { name: `${topic}: zwroty praktyczne`, contentType: language ? "vocabulary" : "conceptual" },
      { name: `${topic}: typowe błędy`, contentType: "conceptual" },
    ],
  };
};

// Reads the quotas from the prompt's <podtemat nr=".." pytan=".."> tags, so the quiz always
// matches the schema; the correct answer is the first option (the server shuffles them).
const quiz: FakeFixture = (request) => {
  const tags = [...request.prompt.matchAll(/<podtemat nr="(\d+)" typ="\w+" pytan="(\d+)">([\s\S]*?)<\/podtemat>/g)];
  return {
    questions: tags.flatMap(([, nr, count, name]) =>
      Array.from({ length: Number(count) }, (_, k) => ({
        subtopicIndex: Number(nr),
        question: `${name.slice(0, 60)}: pytanie ${k + 1}`,
        options: [`Poprawna ${k + 1}`, `Błędna A${k + 1}`, `Błędna B${k + 1}`, `Błędna C${k + 1}`],
        correctIndex: 0,
      })),
    ),
  };
};

// Reads the counts and content types from the prompt's <podtemat nr=".." typ=".." fiszek="..">
// tags, so the batch always matches the schema; the correct option is generated apart.
const flashcards: FakeFixture = (request) => {
  const tags = [
    ...request.prompt.matchAll(/<podtemat nr="(\d+)" typ="(\w+)" fiszek="(\d+)" wynik="\d+">([\s\S]*?)<\/podtemat>/g),
  ];
  return {
    cards: tags.flatMap(([, nr, type, count, name]) =>
      Array.from({ length: Number(count) }, (_, k) => ({
        subtopicIndex: Number(nr),
        front: `${name.slice(0, 60)}: fiszka ${k + 1}`,
        correctOption: `Poprawna ${k + 1}`,
        wrongOptions: [`Błędna A${k + 1}`, `Błędna B${k + 1}`, `Błędna C${k + 1}`],
        answer: `Wzorcowa odpowiedź ${k + 1}.`,
        explanation: `Wyjaśnienie fiszki ${k + 1}: ${name.slice(0, 60)}.`,
        example: type === "vocabulary" ? `Przykładowe zdanie ${k + 1}.` : null,
      })),
    ),
  };
};

// An answer containing this marker fails grading once with ai_unavailable (503, retryable);
// the same text then grades normally, so smoke and e2e can cover retrying a failed grading.
export const FAKE_GRADING_FAIL_ONCE = "[fake-ai-fail-once]";
const failedOnce = new Set<string>();

// The verdict comes from the user's answer in the prompt's <odpowiedz_uzytkownika> tag: it
// is correct when it contains the word "poprawnie", so smoke and dev can reach both paths.
const grading: FakeFixture = (request) => {
  const answer = /<odpowiedz_uzytkownika>([\s\S]*?)<\/odpowiedz_uzytkownika>/.exec(request.prompt)?.[1] ?? "";
  if (answer.includes(FAKE_GRADING_FAIL_ONCE) && !failedOnce.has(answer)) {
    failedOnce.add(answer);
    throw new FakeAiFailure("ai_unavailable");
  }
  const correct = /poprawnie/i.test(answer);
  return {
    correct,
    feedback: correct
      ? "Trafnie oddajesz sedno wzorcowej odpowiedzi."
      : "Zabrakło sedna wzorcowej odpowiedzi — przeczytaj ją poniżej.",
  };
};

// Canned responses for AI_MODE=fake, one entry per task (the `task` passed to callAi).
// Each slice that adds an AI task adds its fixture here.
export const fakeFixtures: Record<string, FakeFixture> = {
  [SUBTOPICS_TASK]: subtopics,
  [QUIZ_TASK]: quiz,
  [FLASHCARDS_TASK]: flashcards,
  // Next batches use the same <podtemat> tags; the <istniejace_pytania> block is not read.
  [NEXT_FLASHCARDS_TASK]: flashcards,
  [GRADING_TASK]: grading,
};
