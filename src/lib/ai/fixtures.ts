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

// Canned responses for AI_MODE=fake, one entry per task (the `task` passed to callAi).
// Each slice that adds an AI task adds its fixture here.
export const fakeFixtures: Record<string, FakeFixture> = {
  [SUBTOPICS_TASK]: subtopics,
};
