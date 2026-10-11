import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { isEmailAllowed } from "@/lib/allowlist";

function signinWithError(context: Parameters<APIRoute>[0], message: string) {
  return context.redirect(`/auth/signin?error=${encodeURIComponent(message)}`);
}

export const GET: APIRoute = async (context) => {
  const params = context.url.searchParams;
  const providerError = params.get("error_description") ?? params.get("error");
  if (providerError) {
    return signinWithError(context, providerError);
  }

  const code = params.get("code");
  if (!code) {
    return signinWithError(context, "Missing authorization code");
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return signinWithError(context, "Supabase is not configured");
  }

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return signinWithError(context, error.message);
  }

  if (!isEmailAllowed(data.user.email)) {
    await supabase.auth.signOut();
    return signinWithError(context, "This account is not on the access list");
  }

  return context.redirect("/dashboard");
};
