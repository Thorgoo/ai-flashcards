// Seed: the pattern every generated browser test copies.
// Protects risk #4 (context/foundation/test-plan.md): the topic -> subtopics -> quiz -> flashcards
// -> study loop breaks in the browser despite green logic tests. This is its first step; the whole
// loop is in critical-path.spec.ts.
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { admin } from "./support/supabase";

// Set once the app has created the topic, so the cleanup also runs after a failure further on.
let topicId: string | undefined;

test.afterEach(async () => {
  if (!topicId) return;
  // Subtopics cascade with the topic. Asserted: a cleanup that deletes nothing turns the run red.
  const { data, error } = await admin().from("topics").delete().eq("id", topicId).select("id");
  topicId = undefined;
  expect(error).toBeNull();
  expect(data).toHaveLength(1);
});

test("a new topic's generated subtopics persist after a page reload", async ({ page }) => {
  const topicName = `E2E seed ${randomUUID().slice(0, 8)}`;

  await page.goto("/dashboard");
  await page.getByRole("link", { name: "Nowy temat", exact: true }).click();
  await expect(page).toHaveURL(/\/topics\/new$/);

  // The submit button is disabled until the React island has hydrated and accepted the name. Only
  // the fill is retried (cleared first: re-filling the same text fires no change event); the
  // submit creates a record, so it runs once.
  const nameField = page.getByLabel("Temat", { exact: true });
  const create = page.getByRole("button", { name: "Utwórz i wygeneruj podtematy", exact: true });
  await expect(async () => {
    await nameField.fill("");
    await nameField.fill(topicName);
    await expect(create).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await create.click();

  await page.waitForURL(/\/topics\/[0-9a-f-]{36}(\?|$)/);
  topicId = /\/topics\/([0-9a-f-]{36})/.exec(page.url())?.[1];

  // Generated on arrival by the fake AI. The editor drops ?generate=1 once it starts, so the
  // reload below cannot trigger a second generation.
  const subtopics = page.getByRole("textbox", { name: "Nazwa podtematu", exact: true });
  await expect(page.getByRole("heading", { level: 1, name: topicName })).toBeVisible();
  await expect(subtopics).toHaveCount(5, { timeout: 30_000 });
  await expect(page).not.toHaveURL(/generate=1/);
  const generated = await subtopics.evaluateAll((fields) => fields.map((field) => (field as HTMLInputElement).value));

  await page.reload();

  // The same list comes back from the server, in the browser and in the database.
  await expect(page.getByRole("heading", { level: 1, name: topicName })).toBeVisible();
  await expect(subtopics).toHaveCount(5);
  for (const [index, name] of generated.entries()) {
    await expect(subtopics.nth(index)).toHaveValue(name);
  }
  const { count, error } = await admin()
    .from("subtopics")
    .select("id", { count: "exact", head: true })
    .eq("topic_id", topicId);
  expect(error).toBeNull();
  expect(count).toBe(5);
});
