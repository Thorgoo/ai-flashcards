import type { SupabaseClient } from "@supabase/supabase-js";
import { AiQuotaExceeded, type AiQuota } from "./call";

interface BeginAiCallRow {
  call_id: string;
  remaining: number;
}

// Daily limits live in the database (begin_ai_call / finish_ai_call); this only maps the RPCs.
export function createSupabaseQuota(supabase: SupabaseClient): AiQuota {
  return {
    async begin(kind, task, model) {
      const result = await supabase.rpc("begin_ai_call", { p_kind: kind, p_task: task, p_model: model });
      if (result.error) {
        if (result.error.code === "P0429") {
          throw new AiQuotaExceeded();
        }
        throw new Error(`begin_ai_call failed: ${result.error.message}`);
      }
      const row = (result.data as BeginAiCallRow[] | null)?.at(0);
      if (!row) {
        throw new Error("begin_ai_call returned no row");
      }
      return { callId: row.call_id, remaining: row.remaining };
    },
    async finish(callId, outcome) {
      const { error } = await supabase.rpc("finish_ai_call", {
        p_call_id: callId,
        p_status: outcome.status,
        p_error_code: outcome.errorCode,
        p_latency_ms: outcome.latencyMs,
        p_input_tokens: outcome.inputTokens,
        p_output_tokens: outcome.outputTokens,
      });
      if (error) {
        throw new Error(`finish_ai_call failed: ${error.message}`);
      }
    },
  };
}
