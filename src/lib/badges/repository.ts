import type { SupabaseClient } from "@supabase/supabase-js";
import type { BadgeKind, BadgeOverview, EarnedBadge } from "./catalog";

// One element of badge_overview().badges (jsonb, snake_case).
interface OverviewBadgeRow {
  kind: BadgeKind;
  threshold: number | null;
  topic_id: string | null;
  topic_name: string | null;
  topic_archived: boolean;
  awarded_at: string;
}

interface BadgeOverviewRow {
  streak_days: number;
  mastered_cards: number;
  badges: OverviewBadgeRow[];
}

interface AttemptBadgeRow {
  kind: BadgeKind;
  threshold: number | null;
  topic_id: string | null;
  awarded_at: string;
  topic: { name: string; archived_at: string | null } | null;
}

function toEarnedBadge(row: OverviewBadgeRow): EarnedBadge {
  return {
    kind: row.kind,
    threshold: row.threshold,
    topicId: row.topic_id,
    topicName: row.topic_name,
    topicArchived: row.topic_archived,
    awardedAt: row.awarded_at,
  };
}

// The caller's progress and earned badges; badge_overview() always returns one row.
export async function getBadgeOverview(supabase: SupabaseClient): Promise<BadgeOverview> {
  const result = await supabase.rpc("badge_overview");
  if (result.error) {
    throw new Error(`loading badge overview failed: ${result.error.message}`);
  }
  const [row] = result.data as BadgeOverviewRow[];
  return {
    streakDays: row.streak_days,
    masteredCards: row.mastered_cards,
    earned: row.badges.map(toEarnedBadge),
  };
}

// The badges the answer `attemptId` earned (a retry of the attempt reads the same ones), oldest
// first; empty when it earned none. The database awards them (sync_badges), never this code.
export async function getAttemptBadges(supabase: SupabaseClient, attemptId: string): Promise<EarnedBadge[]> {
  const result = await supabase
    .from("badges")
    .select("kind, threshold, topic_id, awarded_at, topic:topics(name, archived_at)")
    .eq("attempt_id", attemptId)
    .order("awarded_at")
    .order("kind")
    .order("threshold");
  if (result.error) {
    throw new Error(`loading attempt badges failed: ${result.error.message}`);
  }
  return (result.data as unknown as AttemptBadgeRow[]).map((row) =>
    toEarnedBadge({
      kind: row.kind,
      threshold: row.threshold,
      topic_id: row.topic_id,
      topic_name: row.topic?.name ?? null,
      topic_archived: row.topic !== null && row.topic.archived_at !== null,
      awarded_at: row.awarded_at,
    }),
  );
}
