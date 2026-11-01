import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

// The learning loop a new user goes through, driven only by what the user clicks: a topic, its
// generated subtopics, the diagnostic quiz, the first flashcard batch and the study session.
// The AI runs in fake mode (AI_MODE=fake), so every generation succeeds with fixed content.

// Set by the loop test; the later tests of this file continue on the same topic.
let topicId: string;

// A page whose guard refused the step renders an SSR h1 "Najpierw …" instead of its island.
async function expectNotBlocked(page: Page) {
  await expect(page.getByRole("heading", { name: /^Najpierw/ })).toHaveCount(0);
}

test.describe.serial("critical path", () => {
  test("a new topic goes from subtopics through the quiz to a study session", async ({ page }) => {
    // Three AI generations (one of them queued) plus ten quiz answers.
    test.setTimeout(180_000);
    const topicName = `E2E ścieżka ${randomUUID().slice(0, 8)}`;

    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Nowy temat", exact: true }).click();
    await expect(page).toHaveURL(/\/topics\/new$/);

    // The submit button is disabled in the server HTML; React may also clear a value typed
    // before hydration, so fill again until the hydrated form accepts the name.
    const nameField = page.getByLabel("Temat", { exact: true });
    const create = page.getByRole("button", { name: "Utwórz i wygeneruj podtematy", exact: true });
    await expect(async () => {
      await nameField.fill(topicName);
      await expect(create).toBeEnabled({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await create.click();

    // The form opens the editor with ?generate=1, which the editor drops once it starts.
    await page.waitForURL(/\/topics\/[0-9a-f-]{36}(\?|$)/);
    const id = /\/topics\/([0-9a-f-]{36})/.exec(page.url())?.[1];
    if (!id) throw new Error(`no topic id in ${page.url()}`);
    topicId = id;

    // Subtopics: generated on arrival, then confirmed in the dialog.
    await expectNotBlocked(page);
    await expect(page.getByRole("heading", { level: 1, name: topicName })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nazwa podtematu", exact: true })).toHaveCount(5, {
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Zatwierdź listę", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Zatwierdź", exact: true }).click();
    await expect(page.getByText("Zatwierdzony", { exact: true })).toBeVisible();

    // Quiz: started from the topic's link, answered with "Nie wiem" ten times.
    await page.getByRole("link", { name: "Rozpocznij quiz diagnostyczny", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/topics/${topicId}/quiz`));
    await expectNotBlocked(page);
    await expect(page.getByRole("heading", { level: 1, name: "Quiz diagnostyczny" })).toBeVisible();
    const dontKnow = page.getByRole("button", { name: "Nie wiem", exact: true });
    for (let n = 1; n <= 10; n++) {
      // Each question waits for the previous answer to be saved.
      await expect(page.getByText(`Pytanie ${n} z 10`, { exact: true })).toBeVisible({
        timeout: n === 1 ? 30_000 : undefined,
      });
      await dontKnow.click();
    }
    await expect(page.getByRole("heading", { level: 2, name: "Wynik według podtematów" })).toBeVisible();

    // Flashcards: the first batch is queued (202) and polled until it is ready.
    await page.getByRole("link", { name: "Wygeneruj fiszki", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/topics/${topicId}/flashcards`));
    await expectNotBlocked(page);
    await expect(page.getByRole("heading", { level: 2, name: "Partia 1 (opanowane 0/10)" })).toBeVisible({
      timeout: 60_000,
    });

    // Study: the session opens on the first due card of the batch.
    await page.getByRole("link", { name: "Ucz się", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/topics/${topicId}/study$`));
    await expectNotBlocked(page);
    await expect(page.getByRole("heading", { level: 1, name: /: fiszka \d+$/ })).toBeVisible();
    await expect(page.getByText("Pozostało: 10", { exact: true })).toBeVisible();
  });
});
