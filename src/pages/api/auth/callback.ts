import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { isEmailAllowed } from "@/lib/allowlist";

const SIGNIN_FAILED = "Logowanie nie powiodło się. Spróbuj ponownie.";

function signinWithError(context: Parameters<APIRoute>[0], message: string) {
  return context.redirect(`/auth/signin?error=${encodeURIComponent(message)}`);
}

export const GET: APIRoute = async (context) => {
  const params = context.url.searchParams;
  const providerError = params.get("error_description") ?? params.get("error");
  if (providerError) {
    // The provider's text is English, so the user sees a Polish message and the log keeps the detail.
    // eslint-disable-next-line no-console
    console.error("[auth] provider returned an error", providerError);
    return signinWithError(context, SIGNIN_FAILED);
  }

  const code = params.get("code");
  if (!code) {
    return signinWithError(context, "Brak kodu autoryzacji. Spróbuj zalogować się ponownie.");
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return signinWithError(context, "Supabase nie jest skonfigurowany.");
  }

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    // eslint-disable-next-line no-console
    console.error("[auth] exchanging the code failed", error.message);
    return signinWithError(context, SIGNIN_FAILED);
  }

  if (!isEmailAllowed(data.user.email)) {
    await supabase.auth.signOut();
    return signinWithError(context, "To konto nie jest na liście dostępu.");
  }

  return context.redirect("/dashboard");
};
