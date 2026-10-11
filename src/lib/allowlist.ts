import { ALLOWED_EMAILS } from "astro:env/server";

const allowed = new Set(
  (ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

// Fails closed: an unset or empty ALLOWED_EMAILS lets nobody in.
export function isEmailAllowed(email: string | undefined): boolean {
  return email !== undefined && allowed.has(email.trim().toLowerCase());
}
