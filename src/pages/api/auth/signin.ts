import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";

export const POST: APIRoute = async (context) => {
  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(`/auth/signin?error=${encodeURIComponent("Supabase nie jest skonfigurowany.")}`);
  }

  // Origin comes from the request so local dev, branch previews and production all call back to themselves.
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: { redirectTo: `${context.url.origin}/api/auth/callback` },
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[auth] starting the OAuth flow failed", error.message);
    return context.redirect(
      `/auth/signin?error=${encodeURIComponent("Logowanie nie powiodło się. Spróbuj ponownie.")}`,
    );
  }

  return context.redirect(data.url);
};
