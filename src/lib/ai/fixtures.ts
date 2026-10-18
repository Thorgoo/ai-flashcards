import type { FakeFixture } from "./fake";

// Canned responses for AI_MODE=fake, one entry per task (the `task` passed to callAi).
// Each slice that adds an AI task adds its fixture here.
export const fakeFixtures: Record<string, FakeFixture> = {};
