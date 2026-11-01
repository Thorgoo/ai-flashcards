// Signs the e2e account in once and saves its session cookies for the chromium project. OAuth
// cannot run in a test, so (as scripts/smoke-topics.mjs does) the account is created with the
// admin API and signed in with a password; @supabase/ssr writes the cookies exactly as the app
// reads them. The account is recreated on every run, so its daily AI limits start fresh
// (ai_calls cascade with the user).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createServerClient, serializeCookieHeader } from "@supabase/ssr";
import { expect, test as setup } from "@playwright/test";
import { admin, E2E_EMAIL, findUser, supabaseEnv } from "./support/supabase";

const STORAGE_STATE = "e2e/.auth/user.json";

setup("sign in the e2e account", async ({ page }) => {
  const env = supabaseEnv();
  const existing = await findUser(E2E_EMAIL);
  if (existing) {
    const { error } = await admin().auth.admin.deleteUser(existing.id);
    if (error) throw new Error(`deleting ${E2E_EMAIL} failed: ${error.message}`);
  }
  const password = randomUUID();
  const created = await admin().auth.admin.createUser({ email: E2E_EMAIL, password, email_confirm: true });
  if (created.error) throw new Error(`creating ${E2E_EMAIL} failed: ${created.error.message}`);

  const jar = new Map<string, string>();
  const client = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        cookies.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name)));
      },
    },
  });
  const signedIn = await client.auth.signInWithPassword({ email: E2E_EMAIL, password });
  if (signedIn.error) {
    throw new Error(
      `signing in ${E2E_EMAIL} with a password failed: ${signedIn.error.message}. ` +
        "The local stack needs `[auth.email] enable_signup = true` in supabase/config.toml (the email provider).",
    );
  }
  // The session cookie is written from the auth state event, which may land after signIn resolves.
  for (let i = 0; i < 50 && ![...jar.keys()].some((name) => name.includes("auth-token")); i++) {
    await sleep(20);
  }
  if (jar.size === 0) throw new Error(`no session cookie for ${E2E_EMAIL}`);

  // Same encoding as the Cookie header smoke-topics sends.
  const cookies = [...jar].map(([name, value]) => {
    const pair = serializeCookieHeader(name, value, {}).split(";")[0];
    return {
      name,
      value: pair.slice(pair.indexOf("=") + 1),
      domain: "localhost",
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: "Lax" as const,
    };
  });
  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  writeFileSync(STORAGE_STATE, JSON.stringify({ cookies, origins: [] }, null, 2));

  // Proves the cookie format and the allowlist: a refused or unreadable session redirects to sign-in.
  await page.context().addCookies(cookies);
  await page.goto("/dashboard");
  await expect(page).not.toHaveURL(/\/auth\/signin/);
  await expect(page).toHaveURL(/\/dashboard$/);
});
