import { QUIZ_TASK } from "@/lib/topics/quiz-task";
import { SUBTOPICS_TASK } from "@/lib/topics/subtopics-task";
import type { FakeFixture } from "./fake";

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

// Canned responses for AI_MODE=fake, one entry per task (the `task` passed to callAi).
// Each slice that adds an AI task adds its fixture here.
export const fakeFixtures: Record<string, FakeFixture> = {
  [SUBTOPICS_TASK]: subtopics,
  [QUIZ_TASK]: quiz,
};
