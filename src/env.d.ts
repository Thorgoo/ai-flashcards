declare namespace App {
  interface Locals {
    user: import("@supabase/supabase-js").User | null;
  }
}

// The project has no Workers types; only the bindings the app code reads (wrangler.jsonc).
declare module "cloudflare:workers" {
  export const env: {
    // Queue `flashcard-generation`, consumed by src/worker.ts.
    FLASHCARD_JOBS: { send(body: unknown): Promise<void> };
  };
}
