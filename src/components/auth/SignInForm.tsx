import { LogIn } from "lucide-react";
import { SubmitButton } from "@/components/auth/SubmitButton";
import { ServerError } from "@/components/auth/ServerError";

interface Props {
  serverError?: string | null;
}

export default function SignInForm({ serverError }: Props) {
  return (
    <form method="POST" action="/api/auth/signin" className="space-y-4">
      <ServerError message={serverError} />

      <SubmitButton pendingText="Redirecting to GitHub..." icon={<LogIn className="size-4" />}>
        Sign in with GitHub
      </SubmitButton>
    </form>
  );
}
