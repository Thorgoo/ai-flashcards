// Worker entry (wrangler.jsonc `main`): Astro serves requests; the queue consumer runs the
// flashcard generations the API queues, so a reload or a closed tab never cuts them off.
import { handle } from "@astrojs/cloudflare/handler";
import { runFlashcardJob } from "./lib/topics/flashcard-generation";

// The project has no Workers types; only what the consumer uses.
interface QueueBatch {
  messages: readonly { body: unknown; ack(): void }[];
}

export default {
  fetch: handle,
  // max_batch_size 1, max_retries 0: runFlashcardJob never throws and every message is acked.
  async queue(batch: QueueBatch): Promise<void> {
    for (const message of batch.messages) {
      await runFlashcardJob(message.body);
      message.ack();
    }
  },
};
