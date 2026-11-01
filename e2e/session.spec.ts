import { expect, test } from "@playwright/test";

// The saved session (auth.setup.ts) opens the protected dashboard.
test("the signed-in account opens the dashboard", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("link", { name: "Nowy temat" })).toBeVisible();
});
